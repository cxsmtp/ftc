// Theme resolution boot script (v6.8.0).
// Runs synchronously BEFORE the stylesheet loads so the
// html[data-look], [data-theme] and [data-ambient] attributes are already in
// place on first paint.
// Mode precedence: explicit stored choice ("hck-theme" in localStorage) >
// the platform's mode > the house default (HOUSE_MODE, "system": the device's
// own mode). "system" follows the OS (matchMedia); ui/theme.js re-applies on an
// OS change while the preference is "system".
(function () {
  // THE LOOK (html[data-look]) and its ambient light colour (html[data-ambient]),
  // per browser: "hck-look" and "hck-ambient" beside "hck-theme". An unknown or
  // missing look is Ambient, the house default (HOUSE_LOOK, in the device's own
  // mode: HOUSE_MODE); an unknown ambient is none (the
  // look's own default colour). A stored look that is no longer offered (a
  // retired one) counts as no choice. These tables mirror
  // public/js/ui/theme.js LOOKS / AMBIENTS (a classic script cannot import it).
  var LOOKS = { signature: 1, ambient: 1 };
  var AMBIENTS = { violet: 1, cyan: 1, amber: 1, rose: 1, emerald: 1, ice: 1 };
  // With nothing stored the look is the platform's (the page's
  // data-platform-look, below), else the house look; which wins is the
  // precedence below. An ambient-lit look with no colour picked lights its own
  // default: Ambient is Ice (ui/theme.js DEFAULT_AMBIENT mirrors this table).
  var DEFAULT_AMBIENT = { ambient: "ice" };
  var MODES = { system: 1, light: 1, dark: 1 };
  // THE HOUSE DEFAULT: what a browser paints when neither the platform, the
  // event nor the viewer chose (ui/theme.js HOUSE_LOOK / HOUSE_MODE mirror it).
  var HOUSE_LOOK = "ambient", HOUSE_MODE = "system";
  // THE PLATFORM LOOK (lib/platform-look.js) arrives on every page that runs
  // this script (the SPA shell, the help page and the pages opened from email
  // links) as <html data-platform-look='{"look","mode","ambient","lock","stamp"}'>,
  // so it is here before the first frame, signed out included. The precedence, mirrored
  // by ui/theme.js _appearanceSources (change both together):
  //   1. a LOCKED event look, while inside that event (sessionStorage
  //      "hck-event-look", written by ui/theme.js setEventLook);
  //   2. a LOCKED platform look, for anyone this browser does not know as staff
  //      ("hck-staff", written at sign-in by ui/nav.js);
  //   3. this browser's own choice ("hck-look" / "hck-theme" / "hck-ambient"),
  //      unless it was made before the platform's last "Apply to everyone now"
  //      ("hck-look-v" < stamp): then it is dropped here, once;
  //   4. an unlocked event look; 5. the platform look; 6. the house default
  //      (HOUSE_LOOK / HOUSE_MODE: Ambient, following the device).
  function str(s, k) { try { return s.getItem(k); } catch (_) { return null; } }
  var P = {};
  try { P = JSON.parse(document.documentElement.getAttribute("data-platform-look") || "{}") || {}; } catch (_) { P = {}; /* an unrendered placeholder: no platform look */ }
  var pLook = LOOKS.hasOwnProperty(P.look) ? P.look : "";
  var pMode = MODES.hasOwnProperty(P.mode) ? P.mode : "";
  var pAmb = AMBIENTS.hasOwnProperty(P.ambient) ? P.ambient : "";
  var pStamp = typeof P.stamp === "number" && P.stamp > 0 ? P.stamp : 0;
  var ls = null, ss = null;
  try { ls = window.localStorage; } catch (_) { ls = null; }
  try { ss = window.sessionStorage; } catch (_) { ss = null; }
  var ownLook = "", ownMode = "", ownAmb = "";
  if (ls) {
    var ver = parseInt(str(ls, "hck-look-v") || "0", 10) || 0;
    if (pStamp && ver < pStamp) {
      try {
        ls.removeItem("hck-look"); ls.removeItem("hck-theme"); ls.removeItem("hck-ambient");
        ls.setItem("hck-look-v", String(pStamp));
      } catch (_) { /* read-only storage: the choice is simply ignored below */ }
    } else {
      var l0 = str(ls, "hck-look"); if (l0 && LOOKS.hasOwnProperty(l0)) ownLook = l0;
      var t0 = str(ls, "hck-theme"); if (t0 && MODES.hasOwnProperty(t0)) ownMode = t0;
      var a0 = str(ls, "hck-ambient"); if (a0 && AMBIENTS.hasOwnProperty(a0)) ownAmb = a0;
    }
  }
  var E = null;
  try { E = JSON.parse(str(ss || {}, "hck-event-look") || "null"); } catch (_) { E = null; }
  var eLook = E && LOOKS.hasOwnProperty(E.look) ? E.look : "";
  var eLocked = !!(eLook && E.locked);
  var pLocked = !!(P.lock === true && str(ls || {}, "hck-staff") !== "1");
  var look = eLocked ? eLook : (pLocked ? (pLook || HOUSE_LOOK) : (ownLook || eLook || pLook || HOUSE_LOOK));
  var mode = (pLocked && pMode) ? pMode : (ownMode || pMode || HOUSE_MODE);
  var amb = (pLocked && pAmb) ? pAmb : (ownAmb || pAmb);
  if (!amb && DEFAULT_AMBIENT.hasOwnProperty(look)) amb = DEFAULT_AMBIENT[look];
  if (amb) document.documentElement.setAttribute("data-ambient", amb);
  document.documentElement.setAttribute("data-look", look);
  try {
    // The mode is a PREFERENCE: "system" | "light" | "dark". Only "system"
    // resolves from the OS; nothing stored is the house mode (system) above.
    var t = mode;
    if (t !== "light" && t !== "dark") {
      t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (_) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
  // v7.15.5 — suppress the login-screen FLASH on a deliberate in-app reload.
  // #login-page carries `active` in the markup, so it paints immediately on
  // every load and is only swapped out once boot()'s serial chain (csrf +
  // config, then /api/me, then the competition/role routing) has resolved. On a
  // reload the app itself triggered — entering or leaving impersonation, or the
  // role-change reload — the user is already signed in, so that paint is a lie:
  // they watch the login screen for the length of those round trips before the
  // app appears. The initiator sets sessionStorage["ha:transition"] just before
  // navigating; we consume it here, BEFORE first paint, and show the spinner
  // instead. Read-and-remove makes it strictly one-shot: a crash mid-boot costs
  // one spinner-instead-of-login frame on the next load, never a stuck screen.
  // Anonymous first paint is untouched — no marker, no change.
  try {
    if (sessionStorage.getItem("ha:transition")) {
      sessionStorage.removeItem("ha:transition");
      document.documentElement.classList.add("booting-authed");
    }
  } catch (_) { /* private mode / storage disabled — just show the login page */ }
  // THE SIGNED-IN HEADER'S GEOMETRY. `ha_shell` (lib/sessions.js, features/
  // session-monitor.js setAppShellHint) says what this browser was last showing:
  // `2` the signed-in header (html.app-header-hint), `1` that header and the
  // participant bar under it (plus html.app-shell-hint), `3` the bar with its
  // lock note on a line of its own (plus html.app-note-hint). The CSS gives the
  // still signed-out header that geometry, so boot swapping the signed-in header
  // in does not move the page. Layout only: the sign-in screen still paints, and
  // ui/nav.js drops the classes wherever the header is the signed-out one.
  var shell = /(?:^|;\s*)ha_shell=([123])(?:;|$)/.exec(document.cookie || "");
  if (shell) {
    document.documentElement.classList.add("app-header-hint");
    if (shell[1] !== "2") document.documentElement.classList.add("app-shell-hint");
    if (shell[1] === "3") document.documentElement.classList.add("app-note-hint");
  }
  // v8.14.0 — A PAGE WHOSE APP SCRIPT FAILED TO LOAD RELOADS ITSELF, ONCE.
  // The login page is static markup, so when one request of the SPA's module
  // graph fails in transit (a network blip during the load), the page still
  // paints and looks usable while nothing on it works: Continue does
  // nothing, the theme never follows the OS, the header icons never mount. A
  // failed dependency fails the whole graph, which the browser reports as an
  // `error` event on the entry <script type="module"> (it does not bubble, so
  // listen in the capture phase). Re-importing cannot recover: the document
  // keeps the failed module for its lifetime. A reload can, unless this
  // document IS an automatic reload, or began less than BOOT_RELOAD_GAP_MS
  // after the last one, so a load that keeps failing reloads once and then
  // stays put. The marker (BOOT_RELOAD_MARK) is set just before the reload and
  // read and removed when the next document starts, so a reload whose own
  // document is slow never reloads again. The window covers a manual reload
  // (the notice's button) soon after: the stamp is the failing document's
  // Date.now() just before it reloads, measured at the start of THIS
  // document, never at its failure, or a failure that takes 30 s or more to
  // arrive (a gateway timeout) finds every stamp stale. With no
  // sessionStorage there is no guard, so there is no reload either. A
  // SyntaxError is not a fetch failure: it is reported against window, not
  // the script, so a broken build never reloads.
  // Whenever the page will not reload itself, it says so (#boot-failure, with a
  // Reload button) rather than looking usable while nothing works. Built with
  // DOM calls, never markup: Trusted Types refuses an HTML string here.
  function showBootFailure() {
    if (document.getElementById("boot-failure")) return;
    var box = document.createElement("div");
    box.id = "boot-failure";
    var p = document.createElement("p");
    p.setAttribute("role", "alert");
    p.textContent = "This page did not finish loading. Check your connection, then reload.";
    var b = document.createElement("button");
    b.type = "button";
    b.className = "btn";
    b.textContent = "Reload";
    b.addEventListener("click", function () { location.reload(); });
    box.appendChild(p);
    box.appendChild(b);
    // A reload restores the scroll position against a node BELOW the notice, so
    // the inserted notice pushed it down and the page scrolled the notice away.
    try { history.scrollRestoration = "manual"; } catch (e) { console.warn("Could not stop scroll restoration", e); }
    var host = document.getElementById("app") || document.body;
    host.insertBefore(box, host.firstChild);
    // boot() never ran, so nothing else lifts an in-app reload's spinner mask.
    document.documentElement.classList.remove("booting-authed");
  }
  try {
    var BOOT_RELOAD_KEY = "ha:boot-reload", BOOT_RELOAD_MARK = "ha:boot-reloaded", BOOT_RELOAD_GAP_MS = 30000;
    // This classic script runs in <head>, so this is when the document began.
    // Date.now(), the stamp's own clock: performance.timeOrigin is another.
    var docStart = Date.now();
    var reloadedBySelf = false;
    try {
      reloadedBySelf = sessionStorage.getItem(BOOT_RELOAD_MARK) === "1";
      sessionStorage.removeItem(BOOT_RELOAD_MARK);
    } catch (_) { /* no storage: no reload ever happens, so nothing to read */ }
    window.addEventListener("error", function (e) {
      var s = e && e.target;
      // Only the app's entry script (index.html's <script type="module">); a
      // failed classic script or image, or another module, is not this.
      if (!s || !/^[^?#]*\/js\/core\/main\.js(?:[?#]|$)/.test(s.src || "")) return;
      var reload = false;
      try {
        // A stamp from the future (the clock was set back) is not a recent reload.
        var since = docStart - (parseInt(sessionStorage.getItem(BOOT_RELOAD_KEY) || "0", 10) || 0);
        if (!reloadedBySelf && !(since >= 0 && since < BOOT_RELOAD_GAP_MS)) {
          sessionStorage.setItem(BOOT_RELOAD_KEY, String(Date.now()));
          sessionStorage.setItem(BOOT_RELOAD_MARK, "1");
          reload = true;
        }
      } catch (_) { /* no storage: no guard, so no reload */ }
      if (reload) location.reload();
      else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showBootFailure);
      else showBootFailure();
    }, true);
  } catch (_) { /* no addEventListener: nothing to recover with */ }
})();
