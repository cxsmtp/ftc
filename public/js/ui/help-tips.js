"use strict";
// "?" HELP TIPS — one small reusable control for the 1–2 sentence explanations
// that sit beside a non-obvious control (a filter, a setting, a header button).
//
// THE API (for every screen):
//   • Markup: put an EMPTY placeholder where the tip belongs —
//       <span data-help="people.desk"></span>
//     wireHelpTips() (run once at boot, then by a MutationObserver for anything
//     rendered later) turns it into a 24 px "?" button plus its note. The button
//     carries aria-expanded / aria-controls; the note is a role="note" element
//     right after it, hidden until the button is pressed.
//   • Text: add the strings to HELP_TIPS below, or from a feature module with
//     registerHelpTips({ "people.filters": "…" }). A key with no string renders
//     nothing (a "?" that explains nothing is worse than none).
//   • Role-specific text: a value may be an object { participant, admin,
//     event_admin, superadmin, default }; the current role picks the sentence.
//   • Optional `data-help-label="Filters"` names what the tip explains; the
//     button's accessible name is then "About Filters" (else "More about this").
//   • "Show all tips" (Appearance page) opens every note at once for this
//     browser: localStorage "hck-tips-all" = "1", mirrored on <html data-tips-all>.
//
// The placeholder is replaced IN PLACE by DOM calls (never markup), so it obeys
// Trusted Types and works inside any renderer's output. A renderer that rebuilds
// its container simply emits the placeholder again and the observer re-wires it
// (closed, unless "Show all tips" is on).

import { S } from "../core/state.js";

export const HELP_TIPS = {
  // The account menu
  "menu.view": {
    default: "Switches between running events (Admin View) and taking part as a participant (Participant View). Your sign-in stays the same.",
  },
  "menu.appearance": "Opens the Appearance page: light, dark or follow your device; two looks; and the colour of Ambient's light lines. Kept in this browser only, unless your organisers set the look for everyone.",
  "menu.help": "Opens the guide for your role. To jump straight to one topic, press Search (or Ctrl+K) and type what you need.",
  // The command palette (features/command-palette.js)
  "palette.search": {
    default: "Type a page, an action, an event or a help topic, then press Enter. Arrow keys move through the results; Esc closes.",
    participant: "Type a page, one of your events or a help topic, then press Enter. Arrow keys move through the results; Esc closes.",
  },
  // Appearance page
  "appearance.mode": "Auto follows your device's light or dark setting; Light and Dark pin one.",
  "appearance.look": "A look changes colours and shapes, never what anything does.",
  "appearance.ambient": "The colour of the lines and accents on the Ambient look. Every colour keeps text readable.",
  "appearance.tips": "Opens every \"?\" note on every page at once, for people who prefer to read everything.",
  "appearance.org": "The look every browser gets until its viewer picks one, outside events that set their own; Apply to everyone now also replaces earlier picks. Locked for participants, it beats their pick and an event's unlocked look, and only an event that locks its own look wins inside that event (Settings, Branding).",
  // New event page and the one create form
  "newevent.types": {
    default: "Recommended setup opens the form filled in the way most events of that type run; Start blank opens it empty. Either way you add challenges and invite people from the event's workspace after you create it.",
    event_admin: "Recommended setup starts an event of that type set up the way most of them run: give it a name and a start. You add challenges and invite people from the event's workspace afterwards.",
  },
  "templates.deleted": "Deleted templates wait here so one press of Restore brings them back. After the restore window they are removed for good.",
  "event.kind": "The type decides how the event runs: a short walk-up stand, a timed ranked contest, or a self-paced program to a deadline. The sentence under the choice describes the selected type. The form shows only the settings that type can use, and you can change the type until the event starts.",
  "event.name": "What participants and organisers see in lists, emails and on certificates. Each event needs its own name. It cannot be changed after the event ends.",
  "event.schedule": "When the event opens and when it closes. Times are entered in the timezone you choose, and every participant sees them in their own.",
  "event.timezone": "The zone the start (and any deadline) is typed in. It is not stored: the event keeps the exact moment, and each viewer sees it in their own zone.",
  "event.sessions": "One session: everyone plays in the same window. Several sessions: the same event runs more than once (for example a morning and an afternoon group), and each participant picks one.",
  "event.duration": "How long the event runs from its start. The end time is shown below. You can extend it later; shortening a running event ends it sooner for everyone.",
  "event.deadline": "The moment the event closes. People can start any time before it and go at their own pace. Tick No fixed deadline for an always-open program.",
  "event.lbmode": "Per session: each session has its own leaderboard. Global: one board across every session, each person timed within their own session.",
  "event.reveal": "When the event ends, participants can read the correct answer and the explanation of each challenge. Leave it off if you will reuse the same challenges at another event.",
  "event.attempts": "How many answers each participant may submit per challenge. Blank means no limit. A challenge with its own limit overrides this, and an organiser can grant someone more attempts later.",
  "event.team": "Adds a team ranking (each group's average score) beside the individual one. It appears only once at least two groups with members are assigned to the event.",
  "event.staff": "Normally staff and organisers never appear on the leaderboard. Turn this on to let enrolled staff compete like anyone else; while they compete they cannot edit this event or its challenges, and only sealed challenges can be assigned.",
  "event.presence": "Records how much time each participant spends actively on the platform, in five-minute blocks, for the rankings export. Optionally breaks score ties on it instead of elapsed time.",
  "event.dryrun": "For rehearsals: the event is flagged in the admin list, left out of Analytics by default, and earns no certificates.",
  "event.signup": "What people are asked when they sign up through this event's join link or QR code. Required fields are also asked of people who already signed up through it. Name, company and job title are always asked.",
  "event.late": "Keeps the join link open for a while after the end, so a late walk-up can still play. They are ranked in a separate Late entrants section; everyone else's results are final at the end.",
  "event.trusted": "The venue's shared internet address. Requests from it are not rate-limited while the event runs, so a whole room signing in at once is not throttled. Leave blank if unsure.",
  "event.cxone": "Whether each participant gets a Checkmarx One account, and which tenant and group it lands in. Leave the override blank to use the platform's default tenant.",

  // ── Participant screens ──────────────────────────────────────────────────
  "signin.email": "Type your work email and press Continue. Most accounts get a one-time code by email: it signs you in if you have an account, or lets you create one if you do not. An account that signs in with a password is asked for it, and can still choose an emailed code instead.",
  "signin.code": "Only the newest code works, so use the latest email. You can ask for another one two minutes after the last.",
  "register.location": "Detected from this browser. Emails give dates and times in this timezone, so press change if it is wrong.",
  "events.filters": "Active & Upcoming lists the events you can play now or soon. All also lists the ones that have ended.",
  "events.other": "As staff you can open any event to look around without joining it. You are not ranked unless the event lets staff compete.",
  "tasks.filters": "Solved and Unsolved show the challenges you have, or have not yet, answered correctly. The difficulty chips show what a correct answer is worth.",
  "lb.board": "Ranked by score. On a tie the faster Time to Solve wins: it runs from when you first opened the event until you finished every challenge, or until now. All Solved marks the people who finished.",
  "cert.held": "Anyone can check that a certificate is genuine on the verify page, with its code and your family name. Nothing about you is public until you press Share.",
  "profile.emails": "Sign-in codes go to the primary address only. A new primary email takes effect only once it is confirmed from the message sent to that address.",
  "profile.identity": "The nickname is the name shown on leaderboards. First and last names print on certificates, unless a certificate name is set below.",
  "profile.location": "Emails give dates and times in this timezone.",

  // ── Organiser screens ────────────────────────────────────────────────────
  "ws.join": "Walk-ups scan the QR code or type the code to join this event. Anyone who has it can join, so if it leaks, regenerate it in Join-link settings.",
  "ws.sessions": "Each session is a separate sitting of this event with its own start and end, and each participant picks one. Only sessions that have not started can be edited or deleted.",
  "ws.challenges": "The challenges this event's participants play. Press one to see its points, how many solved it and whether participants can see it. Open Questions lists this event's own questions first, then the Question bank, where you add more.",
  "ws.progress": "How many have finished every challenge, and how many solved each one, so you can see where people are stuck (the leaderboard is under Rankings). Staff, event admins and roles like theirs are not counted unless they take part in an event where staff compete, and answers given while impersonating never are.",
  "ws.ready": "What still needs doing before the start. Each open item has the button that fixes it; Show me points at the button in the header.",
  "ws.certs": "Whether this event's certificates were issued and emailed. They go out a few minutes after the end. Open Certificates to see each one or send one again.",
  "ws.walkups": "Walk-ups join with the event's code. Full-screen QR puts it on the stand's screen; the first press shows the code, which is recorded in the event's History.",
  "ws.organisers": {
    default: "Organisers (event admins) run this event and see its people. Search for someone below to add them; Remove takes this event away from them but leaves their role.",
    event_admin: "The organisers of this event. Only an administrator can add or remove one.",
  },
  "ws.activity": "Joins, answers and correct answers over the event so far, in equal slices of time, updated every 15 seconds. Staff, event admins and roles like theirs are not counted unless they take part in an event where staff compete, and answers given while impersonating never are, so its Joins can be fewer than Joined, which counts everyone enrolled.",
  "ws.feed": "The latest people to join and to solve a challenge, newest first. It updates every 15 seconds.",
  "ws.rates": "For each challenge, how many of the people who tried it have solved it. Staff, organisers and anything done while impersonating are not counted, except the staff and organisers taking part in an event where staff compete.",
  "ws.settings": "A summary of how this event is set up. Edit settings opens the full form; some settings lock once the event starts.",
  "ws.look": "The colours this event's join page and participants see. Lock it to stop participants picking their own look while they are in it.",
  "invite.events": {
    default: "Everyone listed joins the ticked events. Someone with no account yet gets an email invitation and joins when they create their account; a personal address (Gmail and similar) can do that only through the invitation's link.",
    event_admin: "Everyone listed joins the ticked events; tick at least one of yours. Someone with no account yet gets an email invitation and joins when they create their account; a personal address (Gmail and similar) can do that only through the invitation's link.",
  },
  "invite.groups": "Adds everyone listed to the ticked groups. A group bound to an event keeps its members in that event as the group changes.",
  "people.everyone": {
    default: "Lists every account on the platform, not only this event's people, so you can add someone with Add to event.",
    // An organiser's People list holds only the people of the events they run.
    event_admin: "Lists the people of your other events too, not only this event's, so you can add someone with Add to event.",
  },
  "people.admins": "People normally lists participants and organisers. Tick this to list administrator accounts too; they are managed on Roles & permissions.",
  "people.desk": "Creates the account and shows a one-time sign-in code on your screen, for someone standing with you who cannot reach their email.",
  "people.columns": "Choose which columns the table shows. The choice is kept in this browser only.",
  "people.status": "Unconfirmed: has not confirmed their email. Pending: waiting for approval. Denied: refused. Confirmed: can take part. Blocked: stopped by an organiser. Locked: too many wrong codes, for a short while.",
  "library.list": {
    default: "Every bank question you can see, filed by topic. Inside an event, the event's own questions come first (edit them there for that event only) and the rest of the bank is dimmed below them, ready to add.",
    event_admin: "Your bank questions and the shared ones, filed by topic. Inside an event, the event's own questions come first (edit them there for that event only) and the rest is dimmed below them, ready to add.",
  },
  "library.topics": "Show only the questions in one topic, or those with no topic. Topics lists them, with how many of your bank questions each holds, and adds, renames or deletes them.",
  "library.export": {
    default: "Export downloads the challenges listed as a JSON file. A superadmin can import such a file to add or update challenges.",
    superadmin: "Export downloads the challenges listed as a JSON file; Import adds or updates challenges from one, and shows conflicts before anything changes.",
  },
  "groups.list": "A team (group) is a reusable list of people. Bind it to an event and its members join that event, and leave it when they leave the group.",
  "activity.list": "Every answer and hint, newest first. Δ pts is what each one changed the score by: a wrong answer costs points, and a hint costs a share of the challenge's points.",
  "rankings.board": "Ranked by score, with ties broken by time to solve. Benchmark accounts are listed apart and not ranked. Export CSV saves every column, whatever is hidden on screen.",
  "analytics.scope": {
    default: "Global covers every event; events tagged test/dry run are left out unless you change the Event tags filter. Event or Session narrows it to one. Staff are left out by default.",
    event_admin: "Pick one of your events, or one of its sessions. Staff are left out by default.",
  },
  "analytics.columns": "Nav-away counts the times someone left a challenge unsolved. Unique Attempters counts the people with any activity on it, and Solve rate is the share of them who solved it.",
  "logs.streams": "Audit log: what people and the system did. Request log: every web request the server answered.",
};

/** Add or replace tip strings (feature modules call this at boot).
 *  A placeholder already wired while its text was missing (it rendered nothing)
 *  is wired again now, so the order of registration and wiring never matters. */
export function registerHelpTips(map) {
  if (!map || typeof map !== "object") return;
  const added = [];
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === "string" || (v && typeof v === "object")) { HELP_TIPS[k] = v; added.push(k); }
  }
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  for (const k of added) {
    document.querySelectorAll(`[data-help="${CSS.escape(k)}"][data-help-ready]`).forEach((ph) => {
      if (ph.querySelector(".help-tip-btn")) return;
      ph.removeAttribute("data-help-ready");
      ph.hidden = false;
      _wireOne(ph);
    });
  }
}

function _role() {
  if (S.isSuperAdmin) return "superadmin";
  if (S.isEventAdmin) return "event_admin";
  if (S.isAdmin) return "admin";
  return S.userRole || "participant";
}

/** The sentence for a key, resolved for the current role; "" when none. */
export function helpTipText(key) {
  const v = HELP_TIPS[key];
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v[_role()] || v.default || "";
  return "";
}

export function tipsAllOn() {
  try { return localStorage.getItem("hck-tips-all") === "1"; } catch (_) { return false; }
}

let _seq = 0;

function _wireOne(ph) {
  const key = ph.getAttribute("data-help");
  const text = helpTipText(key);
  ph.setAttribute("data-help-ready", "");
  if (!text) { ph.hidden = true; return; }
  const id = `ht-${String(key).replace(/[^a-z0-9_-]/gi, "-")}-${++_seq}`;
  const label = ph.getAttribute("data-help-label");
  const open = tipsAllOn();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "help-tip-btn";
  btn.setAttribute("data-action", "help-tip");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.setAttribute("aria-controls", id);
  btn.setAttribute("aria-label", label ? `About ${label}` : "More about this");
  // The glyph is painted from data-glyph (CSS), never DOM text: a text glyph used
  // as an icon must not enter the accessible name (label-in-name rule).
  btn.setAttribute("data-glyph", "?");
  const note = document.createElement("span");
  note.id = id;
  note.className = "help-tip-note";
  note.setAttribute("role", "note");
  note.textContent = text;
  note.hidden = !open;
  ph.classList.add("help-tip");
  ph.replaceChildren(btn, note);
}

/** Expand every unwired [data-help] placeholder under root. */
export function wireHelpTips(root) {
  const scope = root && root.querySelectorAll ? root : document;
  const list = [];
  if (scope.matches && scope.matches("[data-help]:not([data-help-ready])")) list.push(scope);
  scope.querySelectorAll("[data-help]:not([data-help-ready])").forEach((el) => list.push(el));
  list.forEach(_wireOne);
}

/** Re-word every wired tip whose words depend on the role (an object in
 *  HELP_TIPS). Static placeholders are wired once, at boot, before the account
 *  and its role are known, so the nav builders (ui/nav.js) call this on every
 *  role and view change; a placeholder rendered later is wired with the role it
 *  renders under. */
export function refreshRoleTips() {
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  document.querySelectorAll("[data-help][data-help-ready]").forEach((ph) => {
    const key = ph.getAttribute("data-help");
    const v = HELP_TIPS[key];
    if (!v || typeof v !== "object") return;
    const text = helpTipText(key);
    const note = ph.querySelector(".help-tip-note");
    if (note) { if (text && note.textContent !== text) note.textContent = text; return; }
    if (text) { ph.removeAttribute("data-help-ready"); ph.hidden = false; _wireOne(ph); }
  });
}

/** Toggle one tip from its button (the "help-tip" delegated action). */
export function toggleHelpTip(btn) {
  if (!btn) return;
  const note = document.getElementById(btn.getAttribute("aria-controls") || "");
  if (!note) return;
  const open = btn.getAttribute("aria-expanded") !== "true";
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  note.hidden = !open;
}

/** "Show all tips": persist the choice and open (or close) every note now. */
export function setTipsAll(on) {
  try { localStorage.setItem("hck-tips-all", on ? "1" : "0"); } catch (_) { on = !!on; }
  document.documentElement.toggleAttribute("data-tips-all", !!on);
  document.querySelectorAll(".help-tip-btn").forEach((b) => {
    b.setAttribute("aria-expanded", on ? "true" : "false");
    const n = document.getElementById(b.getAttribute("aria-controls") || "");
    if (n) n.hidden = !on;
  });
}

let _observer = null;
/** Run once at boot: wire what is there and everything rendered later. */
export function installHelpTips() {
  document.documentElement.toggleAttribute("data-tips-all", tipsAllOn());
  wireHelpTips(document);
  if (_observer || typeof MutationObserver !== "function") return;
  _observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.hasAttribute("data-help") || n.querySelector("[data-help]")) wireHelpTips(n);
      }
    }
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}
