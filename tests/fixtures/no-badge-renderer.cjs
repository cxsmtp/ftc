"use strict";

// Preloaded (`node -r`) into a server a spec spawns, to stand for a deployment
// whose `@resvg/resvg-js` binary is missing: the lazy require in lib/badge.js
// (`_loadResvg`) then fails exactly as it would there, so every render answers
// BadgeRenderUnavailable while everything else boots and serves as usual
// (tests/certificate-dispatch.spec.js, sweep #43). Nothing else is touched.
const Module = require("module");

const _resolve = Module._resolveFilename;
Module._resolveFilename = function resolveWithoutRenderer(request, ...rest) {
  if (request === "@resvg/resvg-js") {
    const e = new Error("Cannot find module '@resvg/resvg-js' (test: this server stands for a deployment without its renderer)");
    e.code = "MODULE_NOT_FOUND";
    throw e;
  }
  return _resolve.call(this, request, ...rest);
};
