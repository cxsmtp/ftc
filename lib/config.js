"use strict";

// Foundational, env-derived configuration shared across lib/ + routes/ + server.
// Required once near boot; module caching guarantees SESSION_SECRET is generated
// exactly once per process. DATA_DIR and UPLOADS_DIR are REQUIRED and have no
// fallback (v8.8.26 / v8.8.27) — see lib/data-dir.js, which owns both refusals.

const crypto = require("crypto");

if (!process.env.BASE_URL) {
  console.error("FATAL: BASE_URL environment variable is required.");
  process.exit(1);
}

const PLATFORM_VERSION = require("../version.json").version;
const BASE_URL = process.env.BASE_URL.replace(/\/+$/, "");
// Per-process session secret — random on every startup, so a restart invalidates
// all existing sessions. Generated once (require cache) and shared.
const SESSION_SECRET = crypto.randomBytes(48).toString("base64");
// Startup timestamp — exposed to clients so they can detect a server restart
// (which invalidates sessions). The client compares this across polls.
const SERVER_STARTED_AT = new Date().toISOString();
// v8.8.26 — REQUIRED, no fallback; see lib/data-dir.js for why there is no
// condition on the refusal. Shared with db.js, which cannot require THIS file.
const DATA_DIR = require("./data-dir").requireDataDir();
// Multer temp-upload directory (REQUIRED, no default — see v8.8.27 below). Shared by the
// upload-cleanup helper (lib/http) and the attachment temp-unlink helper
// (lib/attachments), so it lives here in config rather than in either consumer.
//
// v7.15.4 — overridable, for the same reason DATA_DIR is. The test runner starts
// one server PER WORKER, each with its own data dir, but they all pointed at this
// ONE uploads directory: worker A's upload (or its post-submit unlink) changed
// the file count that worker B was using as an assertion, which is what made
// functional-security's "403 before multer parses" test flaky under WORKERS=8.
// Isolating the dir per worker removes the shared mutable state rather than
// papering over the symptom with a retry.
// v8.8.27 — REQUIRED, no fallback, for the same reason DATA_DIR is: the old
// default was `<repo>/uploads`, which on a developer's box was a symlink to the
// live upload volume — and server.js SWEEPS this directory at every boot, so a
// guessed path is one it deletes from.
const UPLOADS_DIR = require("./data-dir").requireUploadsDir();

// How long an emailed verification code (and a pending email change's
// confirmation code) stays usable. v7.20.9 — hoisted here from routes/auth.js
// beside the other shared windows: a second literal in a second file is exactly
// how two windows drift apart silently. routes/auth.js imports it from here.
const CODE_EXPIRY_MS = 48 * 60 * 60 * 1000;

// v7.21.13 — the other two constants that were re-declared per consumer.
//
// Neither had drifted, and that is exactly why they are worth hoisting: an
// identical literal in five files LOOKS correct at every one of them, so the
// first divergence is invisible in review and silent at runtime. CODE_EXPIRY_MS
// above was hoisted for the same reason in v7.20.9; the note it carries — "a
// second literal in a second file is exactly how two windows drift apart" — is
// the whole argument, and it applied to these two all along.
//
// BULK_ADMIN_MAX caps every admin fan-out (invite / assign / approve / group
// membership / bulk challenge-assign). Two copies disagreeing would mean two
// endpoints promising different ceilings while their error messages both said
// "in a single request", so the operator could not tell which limit they hit.
const BULK_ADMIN_MAX = 1000;
// Threshold above which a [perf-span] slow-request line is emitted. Read from
// the environment ONCE here rather than once per route module — a diagnostic
// run that lowers it must lower it everywhere, or the spans go quiet on
// precisely the handlers not being watched.
const PERF_SPAN_SLOW_MS = parseInt(process.env.PERF_SPAN_SLOW_MS) || 300;
// The per-IP limit on the public reads `/api/config` (routes/participant.js) and
// `/api/settings/appearance` (routes/settings.js), each its own bucket.
const RATE_LIMIT_CONFIG_PER_MIN = parseInt(process.env.RATE_LIMIT_CONFIG_PER_MIN, 10) || 120;

// One live code per account, ten minutes, three sends before the budget is spent.
// The TTL is the safe knob for more margin; the LENGTH is not, once it is in email
// templates and a support person's muscle memory.
// Both are env-readable because the README documents them as knobs, and a
// constant documented as a variable is the divergence this codebase keeps
// paying for. Floors, not bare parseInt: a nonsense value must not silently
// produce a zero-length window or a zero-send budget, which would take the
// feature down in a way that looks like the feature being broken.
const LOGIN_CODE_TTL_MS = Math.max(60_000, parseInt(process.env.LOGIN_CODE_TTL_MS, 10) || 10 * 60 * 1000);
const LOGIN_CODE_MAX_SENDS = Math.max(1, parseInt(process.env.LOGIN_CODE_MAX_SENDS, 10) || 3);

module.exports = { PLATFORM_VERSION, BASE_URL, SESSION_SECRET, SERVER_STARTED_AT, DATA_DIR, UPLOADS_DIR, CODE_EXPIRY_MS, BULK_ADMIN_MAX, PERF_SPAN_SLOW_MS, RATE_LIMIT_CONFIG_PER_MIN, LOGIN_CODE_TTL_MS, LOGIN_CODE_MAX_SENDS };
