"use strict";

// ── USERS & ROLES ────────────────────────────────────────────────────────────
//
// The accounts that RUN the platform (every role but Participant) and the roles
// they hold. People is about participants; this page is about organisers,
// admins and the custom roles a superadmin defines.
//
// The server decides every door (`requirePermission`, the escalation rule): this
// page offers a control only when the session's permissions (from
// GET /api/admin/me) include what the route will ask for, and always shows the
// server's refusal in words when one comes back anyway.

import { S } from "../core/state.js";
import { csrfHeaders, fetchJsonObject, fetchJsonList } from "../core/api.js";
import { setSafeHtml } from "../core/trusted-types.js";
import { esc, fmtDt } from "../ui/format.js";
import { overlayDismiss, showModal } from "../ui/modal.js";
import { showToast } from "../ui/toast.js";
import { renderLoadFailure } from "../ui/list-controls.js";
import { registerHelpTips } from "../ui/help-tips.js";
import { compareCompsForPicker } from "./competitions-admin.js";
import { adminCan } from "../ui/nav.js";
import { ICO } from "../ui/icons.js";
// People's account doors, one definition. participants-admin.js imports this
// module too (showUserInRoles); neither reads the other at load time, so the
// cycle is only between functions called later.
import { accountDoors, accountPeerNoteHtml, accountProfileLabel, accountBlockDoorHtml } from "./participants-admin.js";

const _st = { view: "users", perms: new Set(), me: null, users: null, roles: null, sections: [], catalogue: [], comps: null, q: "" };
// The account doors on each user row (owner decision, 27 Nov 2026: admin accounts
// are not on People any more, so their row here offers what People's row menu
// offered them: Edit or View profile, History, Block or Unblock, Unlock, Email
// sign-in code), People's own (participants-admin.js `accountDoors`).
let _loadSeq = 0;

export const USERS_HELP_TIPS = {
  "users.pane": "Everyone who can open the admin panel, and the role each one holds. Participants are under People.",
  "users.roles": "A role is a set of permissions. The four built-in roles never change; a superadmin can add custom roles.",
  "users.scope": "Only their events: the role acts on the events its holders are made organisers of. Every event: it acts on the whole platform.",
  "users.matrix": "Tick what holders of this role may do. A permission marked with a dashed edge says why it cannot be given here.",
  "users.add": "Creates an account that signs in with an emailed code. An address that already has an account keeps it and gets the new role.",
};

const _has = (p) => _st.perms.has(p);
const _isSuper = () => !!(S.isSuperAdmin || (_st.me && _st.me.isSuperAdmin));
const _roleById = (id) => (_st.roles || []).find(r => r.id === id) || null;

// May this session give role `r` to an account, or move an account off it?
// The server's own answer (GET /api/admin/roles `can_give` / `can_take`, from
// `lib/rbac.js` roleAssignDenied, the rule the role change applies), so a dialog
// never offers a move the server refuses. Unknown fails closed.
const _canGive = (r) => !!(r && r.can_give === true);
const _canTake = (r) => !!(r && r.can_take === true);
// The roles Add user may give: an admin role this session may give, never the
// built-in Event admin (granted per event) and never Participant (not an admin
// account). Add user is offered only while there is one.
const _addUserRoles = () => (_st.roles || []).filter(r => r.id !== "participant" && r.id !== "event_admin" && _canGive(r));
const _isGranted = (id) => { const r = _roleById(id); return !!r && r.scope_mode === "granted"; };
const _scopeText = (m) => m === "granted" ? "Only their events" : m === "all" ? "Every event" : "No admin access";

async function _send(method, url, body) {
  let r = null;
  try {
    r = await fetch(url, { method, headers: csrfHeaders({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (_) { return { ok: false, status: 0, d: { error: "The request did not reach the server. Nothing was changed." } }; }
  let d = null;
  try { d = await r.json(); } catch (_) { d = null; }
  return { ok: r.ok, status: r.status, d: d || {} };
}

/** Open the Users list searched to one person (People's "Change role on Roles &
 *  permissions": role changes live here only). Called before the page loads. */
export function showUserInRoles(email) {
  _st.view = "users";
  _st.q = String(email || "");
}

export async function loadUsersPane() {
  const seq = ++_loadSeq;
  const body = document.getElementById("ua-body");
  if (!body) return;
  // The rows the account doors act on: People's own projection of these accounts
  // (GET /api/admin/participants?kind=admins: each row's privileged-target answer,
  // rival mark, lock and status, the profile the editor opens), read only by a
  // role that may read People (`participants.view`, the route's permission).
  const canPeople = adminCan("participants.view");
  const [me, users, roles, people] = await Promise.all([
    fetchJsonObject("/api/admin/me"),
    fetchJsonObject("/api/admin/users"),
    fetchJsonObject("/api/admin/roles"),
    canPeople ? fetchJsonObject("/api/admin/participants?kind=admins&limit=5000") : Promise.resolve(null),
  ]);
  if (seq !== _loadSeq) return;
  // A failed read of the doors' rows leaves the doors off, with a sentence (the
  // list itself still renders): never a door acting on a row it could not read.
  S.adminUserRows = people && Array.isArray(people.participants) ? people.participants : null;
  _st.doorsUnread = canPeople && !S.adminUserRows;
  if (!me || !users || !roles || !Array.isArray(users.users) || !Array.isArray(roles.roles)) {
    renderLoadFailure("ua-body", { noun: "users and roles", retryAction: "ua-reload" });
    return;
  }
  _st.me = me;
  _st.perms = new Set(Array.isArray(me.permissions) ? me.permissions : []);
  _st.users = users.users;
  _st.roles = roles.roles;
  _st.sections = roles.sections || [];
  _st.catalogue = roles.permissions || [];
  _render();
}

function _render() {
  const body = document.getElementById("ua-body");
  if (!body) return;
  const tab = (v, label) => `<button type="button" class="ua-switch-btn" role="tab" data-action="ua-view" data-view="${v}" aria-selected="${_st.view === v}">${esc(label)}</button>`;
  setSafeHtml(body, `<div class="ua-switch" role="tablist" aria-label="Roles and permissions">${tab("users", `Users (${_st.users.length})`)}${tab("roles", `Roles (${_st.roles.length})`)}</div>
    <div id="ua-view-users" ${_st.view === "users" ? "" : "hidden"}>${_usersToolbarHtml()}<div id="ua-users-list"></div></div>
    <div id="ua-view-roles" ${_st.view === "roles" ? "" : "hidden"}><div id="ua-roles-list"></div></div>`);
  const q = document.getElementById("ua-search");
  if (q) {
    q.value = _st.q;
    q.addEventListener("input", () => { _st.q = q.value; _renderUsers(); });
  }
  _renderUsers();
  _renderRoles();
}

function _usersToolbarHtml() {
  return `<div class="ua-toolbar">
      <div class="search-wrap"><input id="ua-search" placeholder="Search name, email or role…" aria-label="Search platform users" autocomplete="off"/></div>
      ${!_has("users.manage") ? "" : _addUserRoles().length ? `<button type="button" class="btn" data-action="ua-add-user">Add user</button> <span data-help="users.add" data-help-label="Add user"></span>`
        : `<p class="t-small" id="ua-add-none">Your role cannot give any admin role, so it cannot add users.</p>`}
    </div>`;
}

function _renderUsers() {
  const host = document.getElementById("ua-users-list");
  if (!host) return;
  const q = _st.q.trim().toLowerCase();
  const rows = _st.users.filter(u => !q || [u.email, u.first_name, u.last_name, u.nickname, u.role_label, u.role].some(v => String(v || "").toLowerCase().includes(q)));
  if (!rows.length) {
    // A participant is not listed here: Add user gives an existing account an
    // admin role (People's role link lands here on their address).
    const addHint = q && _has("users.manage") && _addUserRoles().length ? " To give a participant an admin role, use Add user with their address." : "";
    setSafeHtml(host, `<p class="ws-empty">${q ? `No platform user matches “${esc(_st.q)}”.${addHint}` : "No platform users yet."}</p>`);
    return;
  }
  const myId = S.currentUser && S.currentUser.id;
  const canManage = _has("users.manage");
  const canGrant = _has("events.organisers") && _has("events.view");   // its dialog lists the events (`events.view`)
  // An admin data table (ui/table-columns.js, PLAIN_TABLES.users): Columns,
  // and sort and filter on every heading. Last sign-in shows a date as words, so
  // its cell carries the instant (data-sort-value) a sort and a date filter read.
  // The account doors act on People's own rows for these accounts; when that read
  // failed, say so rather than leave the doors silently missing.
  const unread = _st.doorsUnread ? `<p class="t-small" id="ua-doors-unread" role="status">These accounts' details could not be read, so their account actions (profile, history, block, unlock, sign-in code) are not offered. Reload the page to try again.</p>` : "";
  setSafeHtml(host, `${unread}<div class="table-card ua-table-wrap"><table class="ua-table" data-tcols="users">
    <thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th><th scope="col">Events</th><th scope="col">Status</th><th scope="col" data-tcol="last_sign_in">Last sign-in</th><th scope="col" data-tcol="actions">Actions</th></tr></thead>
    <tbody>${rows.map(u => {
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.nickname || "—";
      const events = u.scope_mode === "granted"
        ? (u.grants.length ? u.grants.map(g => `<span class="chip">${esc(g.name)}</span>`).join(" ") : `<span class="t-muted">None yet</span>`)
        : u.scope_mode === "all" ? `<span class="t-muted">Every event</span>` : `<span class="t-muted">—</span>`;
      const self = myId && u.id === myId;
      // A rival's role is a competitor door (the server refuses it): withheld, with the reason.
      const rival = !self && u.rival_in && u.rival_in.id ? u.rival_in : null;
      const acts = [];
      if (canManage && !self && !rival && _canTake(_roleById(u.role))) acts.push(`<button type="button" class="btn secondary sm" data-action="ua-change-role" data-user-id="${esc(u.id)}" aria-label="Change role — ${esc(name)}">Change role</button>`);
      if (canManage && rival) acts.push(`<span class="t-muted ua-rival-note">You compete alongside them in “${esc(rival.name || "an event")}”, so their role cannot be changed from here</span>`);
      if (canGrant && u.scope_mode === "granted") acts.push(`<button type="button" class="btn secondary sm" data-action="ua-events" data-user-id="${esc(u.id)}" aria-label="Events — choose which events ${esc(name)} organises">Events</button>`);
      if (self) acts.push(`<span class="t-muted">You</span>`);
      acts.push(_doorsMenu(u, name));
      return `<tr>
        <td>${esc(name)}</td><td>${esc(u.email || "")}</td>
        <td><span class="chip ua-role-chip">${esc(u.role_label || u.role)}</span></td>
        <td>${events}</td>
        <td>${esc(u.status)}</td>
        <td data-sort-value="${esc(u.last_login_time || "")}">${u.last_login_time ? esc(fmtDt(u.last_login_time, "short")) : '<span class="t-muted">Never</span>'}</td>
        <td class="ua-actions">${acts.join(" ") || '<span class="t-muted">—</span>'}</td></tr>`;
    }).join("")}</tbody></table></div>`);
}

/**
 * The row's account doors, as People's row menu offers them (its predicates,
 * `accountDoors`), behind one "⋮" menu. A door the role may not use is withheld,
 * and a privileged account's note says who manages it. Nothing for a role that
 * cannot read People's rows: the doors act on those rows.
 */
function _doorsMenu(u, name) {
  const p = (S.adminUserRows || []).find(x => x.id === u.id);
  if (!p) return "";
  // The same items, in the same order and words, as People's row menu.
  const items = [accountPeerNoteHtml(p),
    `<button data-action="participant-edit-profile" data-user-id="${esc(p.id)}">${ICO.edit} ${esc(accountProfileLabel(p))}</button>`,
    `<button data-action="participant-history" data-user-id="${esc(p.id)}">${ICO.clock} History</button>`,
    accountBlockDoorHtml(p),
    accountDoors(p).canReset ? `<button data-action="participant-email-code" data-user-id="${esc(p.id)}">${ICO.key} Email sign-in code</button>` : "",
  ].filter(Boolean).join("");
  return `<button type="button" class="kebab-btn kebab-always ua-doors" data-action="kebab-toggle" aria-label="More actions for ${esc(name)}">⋮</button><div class="kebab-menu">${items}</div>`;
}

function _renderRoles() {
  const host = document.getElementById("ua-roles-list");
  if (!host) return;
  const canEdit = _has("roles.manage");
  setSafeHtml(host, `<div class="ua-toolbar"><p class="t-small">Roles decide what people can do <span data-help="users.roles" data-help-label="Roles"></span></p>
      ${canEdit ? `<button type="button" class="btn" data-action="ua-role-new">New role</button>` : ""}</div>
    <ul class="ua-roles" role="list">${_st.roles.map(r => `<li class="card ua-role">
      <div class="ua-role-head"><h3 class="ua-role-title">${esc(r.label)}</h3>${r.builtin ? '<span class="chip">Built-in</span>' : '<span class="chip">Custom</span>'}</div>
      <p class="t-small ua-role-desc">${esc(r.description || "")}</p>
      <p class="t-small ua-role-meta">${esc(_scopeText(r.scope_mode))} · ${r.permissions.length} permission${r.permissions.length === 1 ? "" : "s"} · ${r.user_count} ${r.user_count === 1 ? "person" : "people"}</p>
      <div class="ua-role-acts">
        ${r.builtin || !canEdit
          ? `<button type="button" class="btn secondary sm" data-action="ua-role-open" data-role-id="${esc(r.id)}" aria-label="View — ${esc(r.label)} role">View</button>`
          : `<button type="button" class="btn secondary sm" data-action="ua-role-open" data-role-id="${esc(r.id)}" aria-label="Edit — ${esc(r.label)} role">Edit</button>`}
        ${!r.builtin && canEdit ? `<button type="button" class="btn secondary sm" data-action="ua-role-delete" data-role-id="${esc(r.id)}" aria-label="Delete — ${esc(r.label)} role">Delete</button>` : ""}
      </div></li>`).join("")}</ul>`);
}

export function setUsersView(v) {
  _st.view = v === "roles" ? "roles" : "users";
  _render();
}

// ── dialogs ──────────────────────────────────────────────────────────────────

function _dialog(id, title, inner, submitText) {
  document.getElementById(id)?.remove();
  const ov = document.createElement("div");
  ov.id = id;
  ov.className = "ws-dialog-overlay";
  setSafeHtml(ov, `<form class="card ws-dialog ua-dialog" role="dialog" aria-modal="true" aria-labelledby="${id}-title" novalidate>
    <h3 id="${id}-title" class="modal-title">${esc(title)}</h3>
    ${inner}
    <p class="ws-dialog-err" id="${id}-err" role="alert"></p>
    <div class="modal-foot"><button type="button" class="btn secondary" data-ua-cancel>${submitText ? "Cancel" : "Close"}</button>${submitText ? `<button type="submit" class="btn">${esc(submitText)}</button>` : ""}</div>
  </form>`);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  overlayDismiss(ov, close);
  ov.querySelector("[data-ua-cancel]").addEventListener("click", close);
  const err = (m) => { const e = ov.querySelector(`#${id}-err`); if (e) e.textContent = m || ""; };
  setTimeout(() => { const f = ov.querySelector("input:not([disabled]),select:not([disabled])") || ov.querySelector("button"); if (f) f.focus(); }, 0);
  return { ov, form: ov.querySelector("form"), close, err };
}

// The roles a dialog offers. Never the built-in event admin as a NEW role: its
// scope is granted per event (the event's Organisers card, or Events here), so
// a role change would mint an organiser with nothing to organise (CLAUDE.md,
// Event-admin scope). Never a role this session may not give (`_canGive`).
// `current` is the account's role, kept as the selected option so the dialog
// shows where it starts.
function _roleOptions(current, { withParticipant = true } = {}) {
  return [..._st.roles].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .filter(r => r.id === current || ((withParticipant || r.id !== "participant") && r.id !== "event_admin" && _canGive(r)))
    .map(r => `<option value="${esc(r.id)}"${r.id === current ? " selected" : ""}>${esc(r.label)} — ${esc(_scopeText(r.scope_mode))}</option>`).join("");
}

export function openAddUser() {
  const roles = _roleOptions(_canGive(_roleById("admin")) ? "admin" : null, { withParticipant: false });
  const { form, close, err } = _dialog("ua-add", "Add user", `
    <div class="form-group"><label for="ua-add-email">Email</label><input id="ua-add-email" type="email" required autocomplete="off"/></div>
    <div class="form-group"><label for="ua-add-first">First name <span class="t-muted">(optional)</span></label><input id="ua-add-first" type="text" maxlength="80" autocomplete="off"/></div>
    <div class="form-group"><label for="ua-add-last">Last name <span class="t-muted">(optional)</span></label><input id="ua-add-last" type="text" maxlength="80" autocomplete="off"/></div>
    <div class="form-group"><label for="ua-add-role">Role</label><select id="ua-add-role">${roles}</select></div>
    <p class="t-small">They sign in with a code emailed to this address.</p>`, "Add user");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.querySelector("#ua-add-email").value.trim();
    const role = form.querySelector("#ua-add-role").value;
    if (!email) { err("Enter an email address."); return; }
    const r = await _send("POST", "/api/admin/users", { email, role, first_name: form.querySelector("#ua-add-first").value, last_name: form.querySelector("#ua-add-last").value });
    if (r.ok) { close(); showToast(`Added ${email}.`, "success"); loadUsersPane(); return; }
    if (r.status === 409 && r.d.code === "user_exists" && r.d.id) {
      const role0 = _roleById(role);
      const go = await showModal({ title: "That address has an account", message: `Give the existing account the ${esc(role0 ? role0.label : role)} role instead?`, confirmText: "Change role", confirmClass: "" });
      if (!go) return;
      const p = await _send("PATCH", `/api/admin/users/${encodeURIComponent(r.d.id)}/role`, { role });
      if (p.ok) { close(); showToast(`${email} now holds that role.`, "success"); loadUsersPane(); return; }
      err(p.d.error || "The role was not changed.");
      return;
    }
    err(r.d.error || "The user was not added.");
  });
}

export function openChangeRole(userId) {
  const u = (_st.users || []).find(x => x.id === userId);
  if (!u) return;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
  const { form, close, err } = _dialog("ua-role-change", `Change role — ${name}`, `
    <div class="form-group"><label for="ua-rc-role">Role</label><select id="ua-rc-role">${_roleOptions(u.role)}</select></div>
    <p class="t-small" id="ua-rc-desc"></p>
    <p class="t-small ua-rc-grants" id="ua-rc-grants" role="note" hidden></p>
    <p class="t-small">They are signed out everywhere so the new role applies at once. Moving to Participant removes them from this list.</p>`, "Change role");
  const sel = form.querySelector("#ua-rc-role");
  const desc = form.querySelector("#ua-rc-desc");
  const grants = form.querySelector("#ua-rc-grants");
  // LEAVING a role scoped to its events (the event admin, or a custom role of
  // that scope) for one that is not drops every organiser grant in the same
  // write, and putting the role back does not restore them: said BEFORE the
  // click, with the count, as the People role control says it.
  const nGrants = Array.isArray(u.grants) ? u.grants.length : 0;
  const sync = () => {
    const r = _roleById(sel.value);
    desc.textContent = r ? (r.description || _scopeText(r.scope_mode)) : "";
    const losing = sel.value !== u.role && _isGranted(u.role) && !_isGranted(sel.value);
    grants.hidden = !losing;
    grants.textContent = losing ? `This also removes every event they organise${nGrants ? ` (${nGrants})` : ""}. Putting the role back does not restore them — each event has to be granted again.` : "";
  };
  sel.addEventListener("change", sync); sync();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sel.value === u.role) { close(); return; }
    const r = await _send("PATCH", `/api/admin/users/${encodeURIComponent(u.id)}/role`, { role: sel.value });
    if (r.ok) {
      close();
      // The server's own count, never the row's: a grant made after the list loaded is cleared too.
      const cleared = Number(r.d.event_admin_grants_cleared) || 0;
      showToast(`Role changed.${cleared ? ` ${cleared} event grant${cleared === 1 ? "" : "s"} cleared.` : ""}`, "success");
      loadUsersPane();
      return;
    }
    err(r.d.error || "The role was not changed.");
  });
}

// One open token for the Events dialog: it awaits the event list before it
// renders, so a second press (another person's Events) supersedes the first,
// whose answer then paints nothing (CLAUDE.md, Stale-response guards).
let _uaEventsOpenSeq = 0;
export async function openUserEvents(userId) {
  const u = (_st.users || []).find(x => x.id === userId);
  if (!u) return;
  const seq = ++_uaEventsOpenSeq;
  const raw = await fetchJsonList("/api/admin/competitions");
  if (seq !== _uaEventsOpenSeq) return;
  if (!raw) { showToast("The events did not load. Nothing was changed.", "error"); return; }
  // The shared order of every admin event picker: live first, then upcoming by
  // soonest start, then ended by latest start.
  const comps = raw.slice().sort(compareCompsForPicker);
  const held = new Set(u.grants.map(g => g.competition_id));
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email;
  const { form, close, err } = _dialog("ua-events", `Events — ${name}`, `
    <div class="search-wrap"><input id="ua-ev-q" placeholder="Find an event…" aria-label="Find an event" autocomplete="off"/></div>
    <ul class="ua-ev-list" role="list">${comps.map(c => `<li><label class="checkbox-row" data-search="${esc(String(c.name || "").toLowerCase())}"><input type="checkbox" value="${esc(c.id)}"${held.has(c.id) ? " checked" : ""}/> <span>${esc(c.name)}</span></label></li>`).join("")}</ul>`, "Save");
  const q = form.querySelector("#ua-ev-q");
  q.addEventListener("input", () => {
    const t = q.value.trim().toLowerCase();
    form.querySelectorAll(".ua-ev-list label").forEach(l => { l.closest("li").hidden = !!t && !l.dataset.search.includes(t); });
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const want = new Set([...form.querySelectorAll(".ua-ev-list input:checked")].map(i => i.value));
    const adds = [...want].filter(id => !held.has(id));
    const drops = [...held].filter(id => !want.has(id));
    const failed = [];
    for (const id of adds) { const r = await _send("POST", `/api/admin/competitions/${encodeURIComponent(id)}/admins`, { userId: u.id }); if (!r.ok) failed.push(r.d.error || "refused"); }
    for (const id of drops) { const r = await _send("DELETE", `/api/admin/competitions/${encodeURIComponent(id)}/admins/${encodeURIComponent(u.id)}`); if (!r.ok) failed.push(r.d.error || "refused"); }
    if (failed.length) { err(`${failed.length} change${failed.length === 1 ? " was" : "s were"} refused: ${failed[0]}`); loadUsersPane(); return; }
    close(); showToast("Events saved.", "success"); loadUsersPane();
  });
}

// A permission whose routes reach beyond any one event (`every_event_only`: the
// raw logs, platform settings, imports, deleting accounts, the organiser grant…)
// is held only by a role that acts on every event; the server refuses it for a
// scoped role by name, so it is never offered there.
const _EVERY_EVENT_ONLY_WHY = "Only a role that acts on every event can hold this: what it does reaches beyond any one event.";
function _permDisabledReason(p, role, readOnly, scope) {
  if (p.id === "panel.access") return "Every admin role has this.";
  if (readOnly) return role && role.builtin ? "Built-in roles cannot be changed." : "You can view this role but not change it.";
  if (!p.grantable) return "Only the built-in roles hold this.";
  if (p.superadmin_only && !_isSuper()) return "Only a superadmin can give this.";
  if (!_has(p.id)) return "Your own role does not hold this.";
  if (p.every_event_only && scope !== "all") return _EVERY_EVENT_ONLY_WHY;
  return "";
}

// The scope radios of a NEW role decide whether the every-event permissions can
// be ticked: re-decided on every change, unticking any the new scope refuses.
function _syncEveryEventPerms(form, role, readOnly) {
  const scope = (form.querySelector('input[name="ua-scope"]:checked') || {}).value || (role ? role.scope_mode : "granted");
  for (const box of form.querySelectorAll(".ua-matrix input[data-every-event]")) {
    const p = _st.catalogue.find(x => x.id === box.dataset.perm);
    if (!p) continue;
    const why = _permDisabledReason(p, role, readOnly, scope);
    box.disabled = !!why;
    if (why === _EVERY_EVENT_ONLY_WHY) box.checked = false;
    const row = box.closest(".ua-perm");
    if (row) row.classList.toggle("is-disabled", !!why);
    const note = row && row.querySelector(".ua-perm-why");
    if (note) note.textContent = why;   // an empty block takes no room (it is display:block)
  }
}

export function openRoleEditor(roleId) {
  const role = roleId ? _roleById(roleId) : null;
  const readOnly = !!(role && role.builtin) || !_has("roles.manage");
  const held = new Set(role ? role.permissions : ["panel.access"]);
  const title = !role ? "New role" : readOnly ? role.label : `Edit role — ${role.label}`;
  const matrix = _st.sections.map(s => {
    const ps = _st.catalogue.filter(p => p.section === s.id);
    if (!ps.length) return "";
    return `<fieldset class="ua-perm-group"><legend class="t-eyebrow">${esc(s.label)}</legend>${ps.map(p => {
      const why = _permDisabledReason(p, role, readOnly, role ? role.scope_mode : "granted");
      const checked = (held.has(p.id) && why !== _EVERY_EVENT_ONLY_WHY) || p.id === "panel.access";
      // An every-event permission always carries its note element, so the scope
      // radios can fill or clear it (_syncEveryEventPerms).
      const note = why ? `<small class="ua-perm-why">${esc(why)}</small>` : (p.every_event_only ? '<small class="ua-perm-why"></small>' : "");
      return `<label class="checkbox-row ua-perm${why ? " is-disabled" : ""}"><input type="checkbox" data-perm="${esc(p.id)}"${p.every_event_only ? " data-every-event" : ""}${checked ? " checked" : ""}${why ? " disabled" : ""}/> <span>${esc(p.label)}${p.superadmin_only ? ' <span class="chip">Superadmin only</span>' : ""}${note}</span></label>`;
    }).join("")}</fieldset>`;
  }).join("");
  const scope0 = role ? role.scope_mode : "granted";
  const scopeCtl = `<fieldset class="ua-scope" aria-labelledby="ua-scope-title"><div class="help-label-row"><p id="ua-scope-title" class="ua-scope-title">Acts on</p><span data-help="users.scope" data-help-label="Acts on"></span></div>
      <label class="checkbox-row"><input type="radio" name="ua-scope" value="granted"${scope0 === "granted" ? " checked" : ""}${role ? " disabled" : ""}/> <span>Only the events they are made an organiser of</span></label>
      <label class="checkbox-row"><input type="radio" name="ua-scope" value="all"${scope0 === "all" ? " checked" : ""}${role ? " disabled" : ""}/> <span>Every event</span></label>
      ${role && !readOnly ? '<p class="t-small">A role\'s scope is fixed once it exists. Create a new role to change it.</p>' : ""}
      ${role && role.scope_mode === "none" ? '<p class="t-small">No admin access.</p>' : ""}
    </fieldset>`;
  const { form, close, err } = _dialog("ua-role-ed", title, `
    <div class="form-group"><label for="ua-re-label">Name</label><input id="ua-re-label" type="text" maxlength="60" value="${esc(role ? role.label : "")}"${readOnly ? " disabled" : ""} autocomplete="off"/></div>
    <div class="form-group"><label for="ua-re-desc">Description <span class="t-muted">(optional)</span></label><textarea id="ua-re-desc" rows="2" maxlength="300"${readOnly ? " disabled" : ""}>${esc(role ? role.description || "" : "")}</textarea></div>
    ${scopeCtl}
    <p class="t-section">Permissions <span data-help="users.matrix" data-help-label="Permissions"></span> <span class="t-muted" id="ua-re-count"></span></p>
    <div class="ua-matrix">${matrix}</div>`, readOnly ? null : (role ? "Save role" : "Create role"));
  const count = () => { const n = form.querySelectorAll(".ua-matrix input:checked").length; form.querySelector("#ua-re-count").textContent = `(${n} selected)`; };
  form.addEventListener("change", (e) => {
    if (e.target && e.target.name === "ua-scope") _syncEveryEventPerms(form, role, readOnly);
    count();
  });
  count();
  if (readOnly) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const permissions = [...form.querySelectorAll(".ua-matrix input:checked")].map(i => i.dataset.perm);
    const label = form.querySelector("#ua-re-label").value.trim();
    const description = form.querySelector("#ua-re-desc").value;
    if (!label) { err("Give the role a name."); return; }
    const r = role
      ? await _send("PUT", `/api/admin/roles/${encodeURIComponent(role.id)}`, { expectedVersion: role.version, label, description, permissions })
      : await _send("POST", "/api/admin/roles", { label, description, scope_mode: (form.querySelector('input[name="ua-scope"]:checked') || {}).value, permissions });
    if (r.ok) { close(); showToast(role ? "Role saved. Its holders see the change within seconds." : "Role created.", "success"); _st.view = "roles"; loadUsersPane(); return; }
    err(r.d.error || "The role was not saved.");
  });
}

export async function deleteRole(roleId) {
  const role = _roleById(roleId);
  if (!role) return;
  const go = await showModal({ title: `Delete the ${role.label} role?`, message: role.user_count ? `${role.user_count} ${role.user_count === 1 ? "person holds" : "people hold"} this role. Give them another role first.` : "Nobody holds this role. Deleting it cannot be undone.", confirmText: "Delete role" });
  if (!go) return;
  const r = await _send("DELETE", `/api/admin/roles/${encodeURIComponent(role.id)}`);
  if (r.ok) { showToast("Role deleted.", "success"); loadUsersPane(); return; }
  showToast(r.d.error || "The role was not deleted.", "error");
}

export function initUsersAdmin(registerAction) {
  registerHelpTips(USERS_HELP_TIPS);
  // An account door (People's own handlers) changed an account: the list here
  // follows while it is on screen.
  document.addEventListener("admin:account-changed", () => {
    const pane = document.getElementById("admin-users-tab");
    if (pane && pane.offsetParent !== null) loadUsersPane();
  });
  registerAction("ua-reload", () => loadUsersPane());
  registerAction("ua-view", (e, el) => setUsersView(el.dataset.view));
  registerAction("ua-add-user", () => openAddUser());
  registerAction("ua-change-role", (e, el) => openChangeRole(el.dataset.userId));
  registerAction("ua-events", (e, el) => openUserEvents(el.dataset.userId));
  registerAction("ua-role-new", () => openRoleEditor(null));
  registerAction("ua-role-open", (e, el) => openRoleEditor(el.dataset.roleId));
  registerAction("ua-role-delete", (e, el) => deleteRole(el.dataset.roleId));
}
