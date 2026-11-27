"use strict";

// THE EVENT LOOK — PUT /api/admin/competitions/:id/look { look, locked }.
//
// A look id (or ""/null for none) painted on the event's join landing and for
// its participants while they are inside the event; `locked` also overrides a
// participant's own choice there. Validated by lib/platform-look.js. Its own
// door, like the certificate design, because it is not on the event form: it
// does NOT bump `updated_at` (the form's concurrency token), so saving it never
// 409s an organiser editing the event in another tab.
//
// Gates, in order: 404, the competitor lock (refuseCompetitor), scope
// (competitionDenied: an event admin sets the look of their own events only),
// then the ended-event rule every per-event write shares: only a superadmin
// changes an event whose effective end has passed (`event_look_ended_locked`).
// Audited on the event's History as `look_changed` with reqContext.
// Registered from server.js using an absolute, method-specific path.

const db = require("../db");
const { requireAdmin, csrfProtection } = require("../lib/middleware");
const { getAdminIdentity, recordCompetitionEvent, runTxnWithMirrorBuffer, reqContext } = require("../lib/audit");
const { getCompetition, _invalidateCompetitionCache, competitionStatus, competitionEffectiveEnd } = require("../lib/competitions");
const { competitionDenied, competitorIds } = require("../lib/event-admin");
const { competitorEditDenied, refuseCompetitor } = require("../lib/staff-compete");
const { _invalidateMeCacheForComps } = require("../lib/me-cache");
const { validateEventLook } = require("../lib/platform-look");
const { now } = require("../lib/time");

const BODY_KEYS = ["look", "locked"];

module.exports = function register(app) {
  app.put("/api/admin/competitions/:id/look", requireAdmin, csrfProtection, (req, res) => {
    const comp = getCompetition(req.params.id);
    if (!comp) return res.status(404).json({ error: "Event not found" });
    const cmp = refuseCompetitor(res, competitorEditDenied(db, competitorIds(req), comp.id));
    if (cmp) return cmp;
    const denied = competitionDenied(req, comp.id);
    if (denied) return res.status(403).json({ error: denied.message, code: denied.code });
    if (competitionStatus(comp) === "ended") {
      const effEnd = competitionEffectiveEnd(comp);
      if (effEnd && effEnd <= now() && !req.session.isSuperAdmin) {
        return res.status(403).json({ error: "Only a superadmin can change an event that has ended.", code: "event_look_ended_locked" });
      }
    }
    const body = req.body || {};
    const extra = Object.keys(body).find((k) => !BODY_KEYS.includes(k));
    if (extra !== undefined) return res.status(400).json({ error: `"${String(extra).slice(0, 40)}" is not a field of this request. Send { look, locked }.`, code: "event_look_unknown_key" });
    const v = validateEventLook(body.look, body.locked);
    if (!v.ok) return res.status(400).json({ error: v.error, code: v.code });
    const from = { look: comp.event_look || null, locked: !!(comp.event_look && comp.event_look_locked) };
    const to = { look: v.look, locked: v.locked };
    const changed = from.look !== to.look || from.locked !== to.locked;
    if (changed) {
      const adminId = getAdminIdentity(req);
      const txn = db.transaction(() => {
        db.prepare("UPDATE competitions SET event_look=?, event_look_locked=? WHERE id=?").run(to.look, to.locked ? 1 : 0, comp.id);
        recordCompetitionEvent(comp.id, "look_changed", adminId, { from, to, ...reqContext(req) });
      });
      runTxnWithMirrorBuffer(() => txn());
      // Post-commit: the competition row and every member's /api/me carry it.
      _invalidateCompetitionCache(comp.id);
      _invalidateMeCacheForComps([comp.id]);
    }
    res.json({ ok: true, event_look: to.look, event_look_locked: to.locked, changed });
  });
};
