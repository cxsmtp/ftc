"use strict";

// THE PROFILE CARD — a compact, read-only view of one person, opened from the
// People table (`data-action="participant-view-profile" data-id="<userId>"`: the
// row's own button and the row kebab's "View profile").
//
// WHAT IT SHOWS COMES FROM WHAT THE SERVER ALREADY SCOPED, never wider:
//   • the person: the People list row (`S.adminParticipantsData`, from
//     GET /api/admin/participants). Its `competitions[]` and `groups[]` are
//     narrowed server-side to the viewer's own events and groups (an event admin
//     sees only theirs), so the card lists exactly what the row lists — it adds
//     no event the row does not carry, and fetches nothing by any other id;
//   • certificates: GET /api/admin/competitions/:id/certificates, asked ONLY for
//     events on that same scoped list where one can exist — an ended event, or a
//     live completion-certificate event (a Program issues one while it runs) — and
//     only when the role may read certificates (the route re-checks scope), and
//     only this person's entries are read from each answer;
//   • the open event's score: the table's own score cache (`pScoreFor`).
// The buttons are the doors the row already offers, under the same predicates
// (`impersonateOfferedFor`, `profileReadOnlyFor` in participants-admin.js), so
// the card never offers what the kebab withholds.
//
// Dialog contract: overlayDismiss (Escape, focus trap, focus back to the opener),
// one open token so a slow read cannot paint into a later card, a bottom sheet
// at <=600px. Every button's accessible name opens with its visible words.

import { S } from "../core/state.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { fetchJsonObject } from "../core/api.js";
import { avatarHtml, esc, fmtDt } from "../ui/format.js";
import { ICO } from "../ui/icons.js";
import { overlayDismiss } from "../ui/modal.js";
import { adminCan } from "../ui/nav.js";
import { showToast } from "../ui/toast.js";
import { pStatus, impersonateOfferedFor, profileReadOnlyFor, pScoreFor, adminEditProfile } from "./participants-admin.js";
import { showUserHistory } from "./history.js";
import { compDisplayCategory, COMP_CATEGORY_LABEL } from "./competition-picker.js";
import { impersonateParticipant } from "./impersonation.js";

const OVERLAY_ID = "profile-card-overlay";
// At most this many events are asked for certificates, newest first: the card
// is a glance, and each ask is one request against a rate-limited route. Past the
// cap the note says how many were checked rather than claiming there are none.
const CERT_EVENT_CAP = 6;

const ROLE_LABEL = { superadmin: "Superadmin", admin: "Admin", event_admin: "Event admin", participant: "Participant" };
const STATUS_LABEL = { confirmed: "Confirmed", pending: "Pending approval", unconfirmed: "Unconfirmed", locked: "Locked", blocked: "Blocked", denied: "Denied" };
// An event's status label comes from the ONE table (competition-picker.js),
// by the bucket a human is shown: an ended event still taking late entries
// reads "Late entry open", as on the Events list.
const TIER_LABEL = { gold: "1st place", silver: "2nd place", bronze: "3rd place", participation: "Participation", completion: "Completion" };
// Who approved an account, in words: an organiser (`approved_by` holds their
// address, or `superadmin` for the built-in account), or one of the server's
// automatic approvals, which store a key. A key is never printed: one this table
// does not know says nothing rather than show it.
const APPROVED_BY_LABEL = {
  email_proof: "automatically, at sign-up",
  login_code: "automatically, by an emailed sign-in code",
  self_enroll: "automatically, through the event's join link",
  invitation: "automatically, by invitation",
};
function _approvedBy(v) {
  if (!v || typeof v !== "string") return "";
  if (Object.prototype.hasOwnProperty.call(APPROVED_BY_LABEL, v)) return APPROVED_BY_LABEL[v];
  return (v.includes("@") || v === "superadmin") ? `by ${v}` : "";
}

let _openSeq = 0;
let _openUserId = null;

function _row(userId) {
  return (S.adminParticipantsData || []).find((u) => u && u.id === userId) || null;
}

function _fullName(p) {
  return `${p.first_name || ""} ${p.last_name || ""}`.trim() || p.nickname || p.email || "This person";
}

function _localTime(tz) {
  if (!tz) return "";
  try { return fmtDt(new Date(), "long", { timeZone: tz }); } catch (_) { return ""; }
}

function _fact(label, valueHtml) {
  if (valueHtml == null || valueHtml === "") return "";
  return `<div class="pc-fact"><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function _chip(text, cls) {
  return `<span class="pc-chip ${cls || ""}">${esc(text)}</span>`;
}

function _stateChips(p) {
  const st = pStatus(p);
  const out = [_chip(STATUS_LABEL[st] || st, `pc-st-${st}`)];
  out.push(_chip(p.verified ? "Email verified" : "Email not verified", p.verified ? "pc-ok" : "pc-warn"));
  if (st !== "pending" && st !== "denied") out.push(_chip(p.approved ? "Approved" : "Not approved", p.approved ? "pc-ok" : "pc-warn"));
  return out.join("");
}

function _eventsHtml(p) {
  const comps = Array.isArray(p.competitions) ? p.competitions : [];
  if (!comps.length) {
    return `<p class="pc-empty">${S.isEventAdmin ? "Not in any of your events." : "Not in any event."}</p>`;
  }
  const live = pScoreFor(p.id);
  return `<ul class="pc-events">${comps.map((c) => {
    const status = COMP_CATEGORY_LABEL[compDisplayCategory(c)] || c.status || "";
    const score = live && live.compId === c.id ? `<span class="pc-ev-score">Score ${esc(String(live.score))}</span>` : "";
    return `<li class="pc-event" data-comp-id="${esc(c.id)}">
      <span class="pc-ev-name">${esc(c.name || "")}</span>
      <span class="pc-ev-meta">${_chip(status, `pc-ev-${esc(c.status || "")}`)}${c.timeslot_name ? `<span class="pc-ev-slot">${esc(c.timeslot_name)}</span>` : ""}${score}<span class="pc-ev-cert" data-cert-for="${esc(c.id)}"></span></span>
    </li>`;
  }).join("")}</ul>`;
}

function _chipsHtml(items, cls, emptyText) {
  return items.length ? `<div class="pc-chips">${items.map((t) => _chip(t, cls)).join("")}</div>` : `<p class="pc-empty">${esc(emptyText)}</p>`;
}

function _actionsHtml(p) {
  const id = esc(p.id);
  const who = esc(_fullName(p));
  const btns = [];
  if (!profileReadOnlyFor(p)) btns.push(`<button type="button" class="btn sm" data-pc-act="edit" aria-label="Edit profile — ${who}">${ICO.edit} Edit profile</button>`);
  btns.push(`<button type="button" class="btn sm secondary" data-pc-act="history" aria-label="History — ${who}">${ICO.clock} History</button>`);
  if (impersonateOfferedFor(p)) btns.push(`<button type="button" class="btn sm secondary" data-pc-act="impersonate" data-user-id="${id}" aria-label="Impersonate — ${who}">${ICO.eye} Impersonate</button>`);
  return btns.join("");
}

function _cardHtml(p) {
  const name = _fullName(p);
  const approvedBy = _approvedBy(p.approved_by);
  const role = p.role || "participant";
  const local = _localTime(p.timezone);
  const place = [p.city, p.country].filter(Boolean).map(esc).join(", ");
  const linkedin = p.linkedin_url && /^https?:\/\//i.test(p.linkedin_url)
    ? `<a href="${esc(p.linkedin_url)}" target="_blank" rel="noopener noreferrer">${esc(p.linkedin_url.replace(/^https?:\/\/(www\.)?/i, ""))}</a>` : "";
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const groups = (Array.isArray(p.groups) ? p.groups : []).map((g) => g && g.name).filter(Boolean);
  return `<div class="card pc-card" role="dialog" aria-modal="true" aria-labelledby="pc-title">
    <div class="pc-head">
      <div class="pc-avatar" aria-hidden="true">${avatarHtml(p.avatar, 56)}</div>
      <div class="pc-ident">
        <h3 class="pc-title" id="pc-title">${esc(name)}</h3>
        <div class="pc-sub">${p.nickname ? `<span class="pc-nick">@${esc(p.nickname)}</span>` : ""}${_chip(ROLE_LABEL[role] || p.role_label || "Custom role", `pc-role pc-role-${esc(role)}`)}</div>
        <div class="pc-states">${_stateChips(p)}</div>
      </div>
      <button type="button" class="pc-close" data-pc-act="close" aria-label="Close profile" data-glyph="×"></button>
    </div>
    <div class="pc-body">
      <div class="pc-sec">
        <h4 class="pc-h" id="pc-h-work">Work &amp; location</h4>
        <dl class="pc-facts">
          ${_fact("Company", esc(p.company || ""))}
          ${_fact("Job title", esc(p.title || ""))}
          ${_fact("Job function", esc(p.job_function || ""))}
          ${_fact("Location", place)}
          ${_fact("Local time", local ? esc(local) : "")}
          ${_fact("Timezone", esc(p.timezone || ""))}
        </dl>
      </div>
      <div class="pc-sec">
        <h4 class="pc-h" id="pc-h-contact">Contact</h4>
        <dl class="pc-facts">
          ${_fact("Email", p.email ? `<span class="pc-email">${esc(p.email)}</span>` : "")}
          ${_fact("Second email", p.secondary_email ? `<span class="pc-email">${esc(p.secondary_email)}</span>` : "")}
          ${_fact("Pending change", p.pending_email ? `<span class="pc-email">${esc(p.pending_email)}</span> <span class="pc-muted">(waiting for confirmation)</span>` : "")}
          ${_fact("Phone", esc(p.phone || ""))}
          ${_fact("LinkedIn", linkedin)}
        </dl>
      </div>
      <div class="pc-sec pc-sec-wide">
        <h4 class="pc-h" id="pc-h-events">Events</h4>
        ${_eventsHtml(p)}
        <p class="pc-muted pc-cert-note" id="pc-cert-note" role="status"></p>
      </div>
      <div class="pc-sec">
        <h4 class="pc-h" id="pc-h-tags">Tags &amp; groups</h4>
        ${_chipsHtml(tags, "pc-tag", "No tags.")}
        ${_chipsHtml(groups, "pc-group", "No groups.")}
      </div>
      <div class="pc-sec">
        <h4 class="pc-h" id="pc-h-account">Account</h4>
        <dl class="pc-facts">
          ${_fact("Joined", esc(fmtDt(p.created_at, "short")))}
          ${_fact("First sign-in", p.login_time ? esc(fmtDt(p.login_time, "long")) : "Never")}
          ${_fact("Last sign-in", p.last_login_time ? esc(fmtDt(p.last_login_time, "long")) : "Never")}
          ${_fact("Approved", p.approved_at ? `${esc(fmtDt(p.approved_at, "short"))}${approvedBy ? ` <span class="pc-muted">${esc(approvedBy)}</span>` : ""}` : "")}
          ${_fact("Invited", p.invited_at ? `${esc(fmtDt(p.invited_at, "short"))}${p.invited_by ? ` <span class="pc-muted">by ${esc(p.invited_by)}</span>` : ""}` : "")}
          ${_fact("Denied", p.denied_at ? `${esc(fmtDt(p.denied_at, "short"))}${p.denied_reason ? ` <span class="pc-muted">${esc(p.denied_reason)}</span>` : ""}` : "")}
        </dl>
      </div>
    </div>
    <div class="pc-actions">${_actionsHtml(p)}</div>
  </div>`;
}

function _close({ restore = false } = {}) {
  _openSeq++;
  const uid = _openUserId;
  _openUserId = null;
  const ov = document.getElementById(OVERLAY_ID);
  if (ov) ov.remove();
  // overlayDismiss returns focus to the opener; the People table re-renders on
  // its search debounce and polls, so the opener may be a replaced node by now.
  // Then land on the same person's row (its View button, else its menu button)
  // rather than on <body>. Only for a plain close: a door that opens another
  // dialog hands focus to that dialog.
  if (restore && uid) {
    setTimeout(() => {
      const ae = document.activeElement;
      if (ae && ae !== document.body) return;
      const sel = `#admin-participants-body [data-action="participant-view-profile"][data-id="${CSS.escape(uid)}"]`;
      const view = document.querySelector(sel);
      if (view && typeof view.focus === "function") view.focus();
    }, 0);
  }
}

/** Certificates for the person, from their in-scope events that can hold one. */
async function _loadCertificates(p, seq) {
  const note = document.getElementById("pc-cert-note");
  // A role that may not read certificates is not asked about them: the route
  // would refuse every request, and the card would report a failure.
  if (!adminCan("certificates.view")) { if (note) note.textContent = ""; return; }
  // An ended event, or a LIVE completion-certificate event (a Program issues one
  // while it runs). An upcoming event holds none: asking it would only spend one
  // of the capped asks that an older event with a certificate needs.
  const all = (Array.isArray(p.competitions) ? p.competitions : [])
    .filter((c) => c && (c.status === "ended" || (c.status === "live" && c.certificate === "completion")));
  const asked = all.slice(-CERT_EVENT_CAP);
  if (!asked.length) { if (note) note.textContent = ""; return; }
  if (note) note.textContent = "Looking up certificates…";
  let failed = 0, found = 0;
  await Promise.all(asked.map(async (c) => {
    const d = await fetchJsonObject(`/api/admin/competitions/${encodeURIComponent(c.id)}/certificates`);
    if (seq !== _openSeq) return;
    if (!d || !Array.isArray(d.certificates)) { failed++; return; }
    const mine = d.certificates.find((x) => x && x.userId === p.id && !x.revoked);
    const slot = document.querySelector(`#${OVERLAY_ID} [data-cert-for="${CSS.escape(c.id)}"]`);
    if (!mine || !slot) return;
    found++;
    const tier = TIER_LABEL[mine.tier] || mine.label || "Certificate";
    const bits = [tier];
    if (Number.isFinite(mine.rank) && !(mine.tier === "gold" || mine.tier === "silver" || mine.tier === "bronze")) bits.push(`rank ${mine.rank}`);
    if (Number.isFinite(mine.score)) bits.push(`${mine.score} pts`);
    slot.className = `pc-ev-cert pc-chip pc-cert pc-cert-${esc(mine.tier || "")}`;
    slot.textContent = bits.join(" · ");
  }));
  if (seq !== _openSeq || !note) return;
  // The negative is stated only about what was checked.
  note.textContent = failed
    ? `Could not check certificates for ${failed === 1 ? "one event" : `${failed} events`}.`
    : (found ? "" : (asked.length < all.length
      ? `No certificates in the ${asked.length} most recent events checked.`
      : "No certificates issued yet."));
}

/** Open the card for one user id (the delegated `participant-view-profile`). */
export function openProfileCard(userId) {
  const p = _row(userId);
  if (!p) { showToast("This person is not in the loaded list — refresh People and try again.", "error"); return; }
  _close();
  const seq = ++_openSeq;
  _openUserId = userId;
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.className = "pc-overlay";
  setSafeHtml(overlay, _cardHtml(p));
  document.body.appendChild(overlay);
  // Opener captured BEFORE focus moves in (overlayDismiss's restoration rule).
  overlayDismiss(overlay, () => _close({ restore: true }));
  overlay.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("[data-pc-act]") : null;
    if (!b || !overlay.contains(b)) return;
    const act = b.getAttribute("data-pc-act");
    const row = _row(userId) || p;
    if (act === "close") { _close({ restore: true }); return; }
    _close();
    if (act === "edit") adminEditProfile(userId);
    else if (act === "history") showUserHistory(userId);
    else if (act === "impersonate") impersonateParticipant(userId, row.nickname || "", row.role || "participant");
  });
  const first = overlay.querySelector(".pc-close");
  if (first) first.focus();
  _loadCertificates(p, seq);
}

/** Test/diagnostic: which user's card is open (null when none). */
export function profileCardOpenFor() { return _openUserId; }
