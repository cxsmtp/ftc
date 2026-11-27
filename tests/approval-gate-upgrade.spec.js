"use strict";

// THE APPROVAL QUEUE SURVIVES AN UPGRADE FROM 8.14 (operator ruling, 15 Nov 2026).
//
// 8.14 held every plain sign-up for approval. Since 9.1.1 an emailed code
// approves the account unless a superadmin turns on Require admin approval for
// new accounts — a setting a database from 8.14 has never stored, so it read as
// off and the queue vanished on the upgrade. db.js now turns the switch ON, once,
// for a database coming straight from 8.14 or earlier, and leaves a fresh
// database and one already on 9.1.x as they are. Driven through db.js in a
// throwaway data directory (every test server is a fresh database).

const { test, expect } = require("./isolated-test");

test.describe("Require admin approval — kept on across an upgrade from 8.14", () => {
  test("a database straight from 8.14 boots with the switch on, recorded by system; a fresh one and one already on 9.1.x keep it off (CONTROLS); a superadmin's choice is never overwritten; it runs once", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const { spawnSync } = require("child_process");
    const Database = require("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-approval-"));
    const dbPath = path.join(dir, "hackathon.db");
    const boot = () => {
      const r = spawnSync(process.execPath, ["-e", "require('./db.js')"], {
        cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, DATA_DIR: dir, UPLOADS_DIR: path.join(dir, "uploads"), NODE_OPTIONS: "" },
      });
      expect(r.status, `db.js boot: ${r.stdout}${r.stderr}`).toBe(0);
    };
    const withDb = (fn, readonly = false) => { const d = new Database(dbPath, { readonly }); try { return fn(d); } finally { d.close(); } };
    const switchRow = () => withDb(d => (d.prepare("SELECT value FROM settings WHERE key='require_account_approval'").get() || {}).value ?? null, true);
    const records = () => withDb(d => d.prepare("SELECT changed_by, details FROM settings_events WHERE setting_key='require_account_approval' ORDER BY changed_at").all(), true);
    const marker = () => withDb(d => d.prepare("SELECT value FROM settings WHERE key='approval_gate_upgrade_checked_at'").get(), true);
    // A database as 8.14 left it: no 9.1.1+ marker, and an account in it.
    const as814 = () => withDb(d => {
      d.prepare("DELETE FROM settings WHERE key IN ('approval_gate_upgrade_checked_at','certificate_dispatch_floor_at','require_account_approval')").run();
      d.prepare("DELETE FROM settings_events WHERE setting_key='require_account_approval'").run();
      if (!d.prepare("SELECT 1 FROM users LIMIT 1").get()) {
        const row = {};
        for (const c of d.prepare("PRAGMA table_info(users)").all()) {
          if (c.pk) row[c.name] = "pre-915-user";
          else if (c.notnull && c.dflt_value === null) row[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : (c.name === "email" ? "old@acme.com" : c.name === "nickname" ? "olduser" : "x");
        }
        const names = Object.keys(row);
        d.prepare(`INSERT INTO users (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(n => row[n]));
      }
    });
    try {
      boot();
      expect(switchRow(), "CONTROL: a fresh database keeps the switch off (no row: off)").toBeNull();
      expect(marker(), "the one shot is recorded on a fresh database too").toBeTruthy();

      as814();
      boot();
      expect(switchRow(), "a database straight from 8.14 boots with the queue on").toBe("1");
      const rec = records();
      expect(rec.length, "one record of the change").toBe(1);
      expect(rec[0].changed_by).toBe("system");
      expect(JSON.parse(rec[0].details)).toEqual({ from: false, to: true, via: "upgrade_from_8_14" });

      // Once: a superadmin turns it off; the next boot leaves it off.
      withDb(d => d.prepare("UPDATE settings SET value='0' WHERE key='require_account_approval'").run());
      boot();
      expect(switchRow(), "the next boot never turns it back on").toBe("0");
      expect(records().length).toBe(1);

      // CONTROL: a database already on 9.1.x (its certificate floor stamped by an
      // earlier boot) that never stored the switch keeps it off.
      as814();
      withDb(d => d.prepare("INSERT INTO settings (key, value) VALUES ('certificate_dispatch_floor_at', '2026-11-14T09:30:00.000Z')").run());
      boot();
      expect(switchRow(), "a 9.1.x database keeps the switch as it was").toBeNull();
      expect(records().length).toBe(0);

      // A choice already stored is never overwritten, even on a database from 8.14.
      as814();
      withDb(d => d.prepare("INSERT INTO settings (key, value) VALUES ('require_account_approval', '0')").run());
      boot();
      expect(switchRow(), "a stored choice stands").toBe("0");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
