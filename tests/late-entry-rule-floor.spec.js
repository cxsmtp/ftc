"use strict";

// A FINISHED EVENT KEEPS THE LATE-ENTRY RULE IT ENDED UNDER.
//
// Lateness is derived on every read (lib/late-entry.js). When the operator
// re-decided who counts as late (29 Oct 2026: only somebody who joined strictly
// after the end; before, joining in the last ten minutes counted too), every
// event that had already FINISHED under the old rule had its final board
// rewritten by the upgrade: pre-window joiners moved from the late entrants onto
// the main board with their post-end points. `settings.late_entry_rule_floor_at`
// (db.js) records when the installation took the current rule, and an event that
// ended before it keeps the ten-minute pre-window.
//
//   1. the rule itself, pure: both sides of the floor, both sides of each
//      boundary, and no floor at all (CONTROL);
//   2. the one-shot stamp, driven through db.js in throwaway data directories:
//      a fresh database (the epoch: nothing ended under the old rule there), one
//      that ran 9.1.1+ (its certificate floor), one straight from 8.14 (now).

const { test, expect } = require("./isolated-test");

const MIN = 60_000;

test.describe("late entry — the rule an event ended under", () => {
  test("an event that ended before the floor keeps the ten-minute pre-window; one that ended after it, and any event with no floor, follow the current rule", () => {
    const L = require("../lib/late-entry");
    const before = L.lateEntryRuleFloor();
    try {
      const comp = { event_kind: "booth", late_entry_enabled: 1, late_entry_deadline_at: null };
      const floor = Date.parse("2026-10-29T12:00:00.000Z");
      const oldEnd = new Date(floor - 3 * 86_400_000);
      const newEnd = new Date(floor + 3 * 86_400_000);
      const at = (end, deltaMs) => new Date(end.getTime() + deltaMs).toISOString();
      const late = (end, deltaMs) => L.isLateEntry(comp, end, { assignedAt: at(end, deltaMs), finishTime: null });

      L.setLateEntryRuleFloor(new Date(floor).toISOString());
      expect(L.lateEntryRuleFloor().getTime(), "PRECONDITION: the floor took").toBe(floor);
      // Ended under the old rule: the last ten minutes were late, inclusive.
      expect(late(oldEnd, -5 * MIN), "joined 5 minutes before an old event's end: late, as it ended").toBe(true);
      expect(late(oldEnd, -10 * MIN), "joined exactly 10 minutes before: late (the pre-window's first instant)").toBe(true);
      expect(late(oldEnd, -10 * MIN - 1), "joined just before the pre-window: on the main board").toBe(false);
      expect(late(oldEnd, 1), "joined after the end: late").toBe(true);
      // Ended under the current rule: only after the end.
      expect(late(newEnd, -5 * MIN), "joined 5 minutes before a current event's end: on the main board").toBe(false);
      expect(late(newEnd, 0), "joined at the end itself: on the main board").toBe(false);
      expect(late(newEnd, 1), "joined after the end: late").toBe(true);

      // CONTROL: with no floor every event follows the current rule.
      L.setLateEntryRuleFloor(null);
      expect(L.lateEntryRuleFloor()).toBeNull();
      expect(late(oldEnd, -5 * MIN), "no floor: the old event follows the current rule").toBe(false);
      expect(late(oldEnd, 1)).toBe(true);
      // An unparseable floor is no floor (fails to the current rule, never to "everything is old").
      L.setLateEntryRuleFloor("not a date");
      expect(L.lateEntryRuleFloor()).toBeNull();
    } finally {
      L.setLateEntryRuleFloor(before ? before.toISOString() : null);
    }
  });

  test("the floor is stamped once: the epoch on a fresh database, the certificate floor of an installation already on 9.1.1+, now for a database straight from 8.14", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const Database = require("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-lefloor-"));
    const dbPath = path.join(dir, "hackathon.db");
    // Boots db.js and reports both the stored marker and what the process
    // handed lib/late-entry.js, so the wiring is held as well as the stamp.
    const boot = () => {
      const r = spawnSync(process.execPath, ["-e",
        "const d=require('./db.js'); const L=require('./lib/late-entry'); const f=L.lateEntryRuleFloor();" +
        "process.stdout.write(JSON.stringify({marker:(d.prepare(\"SELECT value FROM settings WHERE key='late_entry_rule_floor_at'\").get()||{}).value||null, floor:f?f.toISOString():null}))"], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
      });
      expect(r.status, `db.js boot: ${r.stdout}${r.stderr}`).toBe(0);
      return JSON.parse(r.stdout.slice(r.stdout.lastIndexOf("{")));
    };
    const withDb = (fn) => { const d = new Database(dbPath); try { return fn(d); } finally { d.close(); } };
    try {
      const fresh = boot();
      expect(fresh.marker, "a fresh database: nothing there ever ended under the old rule").toBe(new Date(0).toISOString());
      expect(fresh.floor, "and the process holds it").toBe(fresh.marker);

      // An installation already on 9.1.1+: its certificate floor (the same release).
      const CERT = "2026-11-14T09:30:00.000Z";
      withDb(d => {
        d.prepare("DELETE FROM settings WHERE key='late_entry_rule_floor_at'").run();
        d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('certificate_dispatch_floor_at', ?)").run(CERT);
      });
      const upgraded = boot();
      expect(upgraded.marker).toBe(CERT);
      expect(upgraded.floor).toBe(CERT);

      // Straight from 8.14: no certificate floor yet, and events exist.
      withDb(d => {
        d.prepare("DELETE FROM settings WHERE key IN ('late_entry_rule_floor_at','certificate_dispatch_floor_at')").run();
        const cols = d.prepare("PRAGMA table_info(competitions)").all();
        const row = {};
        for (const c of cols) {
          if (c.pk) row[c.name] = "pre-915-event";
          else if (c.notnull && c.dflt_value === null) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (c.name.endsWith("_time") || c.name.endsWith("_at") ? "2026-10-01T10:00:00.000Z" : "x");
        }
        const names = Object.keys(row);
        d.prepare(`INSERT INTO competitions (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(n => row[n]));
      });
      const t0 = Date.now();
      const from814 = boot();
      const t1 = Date.now();
      const at = Date.parse(from814.marker);
      expect(at >= t0 - 1000 && at <= t1 + 1000, `a database from 8.14 takes the current rule now: ${from814.marker}`).toBe(true);
      expect(from814.floor).toBe(from814.marker);

      // Once: the next boot keeps it.
      const again = boot();
      expect(again.marker, "the next boot does not move it").toBe(from814.marker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
