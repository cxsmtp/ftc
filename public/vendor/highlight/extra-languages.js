/*
 * v7.20.4 — grammars the vendored highlight.js build does not carry.
 *
 * public/vendor/highlight/highlight.min.js is the upstream "common" build: ~33
 * languages, and NOT dockerfile or powershell. Both were offered in the
 * code-block language menu, so choosing either silently did nothing —
 * hljs.getLanguage() returned undefined, highlightCodeElement fell through to
 * highlightAuto, and the author got whatever auto-detect guessed. A menu entry
 * that quietly does nothing is a wrong answer, not a missing feature.
 *
 * Registering here rather than swapping the bundle keeps the change auditable:
 * the bundle is a vendored 127 KB blob that would have to be re-fetched and
 * re-verified, whereas these are a few dozen readable lines that only ever ADD
 * a language. Same-origin and loaded by a plain <script> like the bundle
 * itself, so the CSP is unaffected.
 *
 * These are deliberately MODEST grammars — instructions/keywords, comments,
 * strings, numbers. They are not upstream's full definitions, and they do not
 * need to be: the alternative being replaced is no highlighting at all.
 * `Docs hygiene > every code-block language is actually registered` fails the
 * build if the menu and the registry ever drift again.
 */
(function () {
  if (typeof window === "undefined" || !window.hljs || !window.hljs.registerLanguage) return;
  var hljs = window.hljs;
  var has = function (n) { return hljs.getLanguage && hljs.getLanguage(n); };

  // ── Dockerfile ──────────────────────────────────────────────────────────
  if (!has("dockerfile")) {
    hljs.registerLanguage("dockerfile", function (h) {
      return {
        name: "Dockerfile",
        aliases: ["docker", "containerfile"],
        case_insensitive: true,
        keywords: {
          keyword:
            "from maintainer expose env arg user onbuild stopsignal shell " +
            "healthcheck label run cmd entrypoint volume workdir copy add as",
        },
        contains: [
          h.HASH_COMMENT_MODE,
          h.APOS_STRING_MODE,
          h.QUOTE_STRING_MODE,
          h.NUMBER_MODE,
          {
            // The shell-ish tail of a RUN/CMD/ENTRYPOINT line, continued across
            // backslash-newline the way a real Dockerfile writes it.
            beginKeywords: "run cmd entrypoint",
            starts: { end: /[^\\]$/, subLanguage: "bash" },
          },
        ],
      };
    });
  }

  // ── PowerShell ──────────────────────────────────────────────────────────
  if (!has("powershell")) {
    hljs.registerLanguage("powershell", function (h) {
      var VARIABLE = { className: "variable", begin: /\$[\w@$]+/ };
      return {
        name: "PowerShell",
        aliases: ["pwsh", "ps", "ps1"],
        case_insensitive: true,
        keywords: {
          keyword:
            "if else elseif switch foreach for while do until break continue " +
            "return function filter param begin process end try catch finally " +
            "throw trap class enum using in exit",
          built_in:
            "Get-ChildItem Get-Content Get-Item Get-Command Get-Help Get-Member " +
            "Set-Content Set-Item Set-Location New-Item New-Object Remove-Item " +
            "Write-Host Write-Output Write-Error Select-Object Where-Object " +
            "ForEach-Object Sort-Object Measure-Object Invoke-WebRequest " +
            "Invoke-RestMethod Invoke-Expression Start-Process Test-Path " +
            "Import-Module Export-Csv ConvertTo-Json ConvertFrom-Json",
          literal: "$true $false $null",
        },
        contains: [
          // <# block comment #> before the # line comment, or the line rule
          // swallows the opening of a block.
          h.COMMENT("<#", "#>"),
          h.HASH_COMMENT_MODE,
          h.QUOTE_STRING_MODE,
          h.APOS_STRING_MODE,
          h.NUMBER_MODE,
          VARIABLE,
          // -Parameter and -eq/-ne style operators
          { className: "literal", begin: /-[a-zA-Z][\w-]*\b/ },
        ],
      };
    });
  }
})();
