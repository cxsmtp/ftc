// v8.12.4 — loaded into a TEST server only when HACKARENA_COVERAGE is set (see
// tests/isolated-test.js). The harness stops servers with SIGKILL, which gives
// V8 no chance to write NODE_V8_COVERAGE, so the harness asks for a dump with
// SIGUSR2 at the end of every spec file instead. takeCoverage() writes a file
// and RESETS the counters, so consecutive dumps never double-count.
"use strict";
const v8 = require("v8");
process.on("SIGUSR2", () => { try { v8.takeCoverage(); } catch (_) {} });
