#!/usr/bin/env node
"use strict";

// PREVIEW the event-owned questions migration (lib/event-copies.js), READ-ONLY.
//
// Upgrading to the release that gives every event its own copy of the questions
// it holds runs a one-shot batch at boot (db.js, marker
// `event_owned_questions_migrated_at`): before any request is answered. So the
// preview cannot be a route — by the time one answers, the batch has run. Run
// this against the database BEFORE the upgrade (the live file, or a copy made by
// scripts/backup.sh); it opens it read-only and writes nothing, and works on a
// database of the previous release (no owner columns yet).
//
//   DATA_DIR=/srv/hackarena/data node scripts/event-copies-dry-run.js [--json]
//
// Prints, per event, how many questions would be copied and how many rows of
// each table would move to the copies.

const path = require("path");
const fs = require("fs");

const dataDir = process.env.DATA_DIR || "";
if (!dataDir) { console.error("DATA_DIR is required (the directory holding hackathon.db)."); process.exit(2); }
const file = path.join(path.resolve(dataDir), "hackathon.db");
if (!fs.existsSync(file)) { console.error(`No database at ${file}.`); process.exit(2); }

const Database = require("better-sqlite3");
const db = new Database(file, { readonly: true, fileMustExist: true });
const { migrateSharedTasksToEventCopies, MOVED_TABLES } = require("../lib/event-copies");
const done = (() => { try { return db.prepare("SELECT value FROM settings WHERE key='event_owned_questions_migrated_at'").get(); } catch { return null; } })();
const rep = migrateSharedTasksToEventCopies(db, { dryRun: true });
db.close();

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify({ already_migrated_at: done ? done.value : null, ...rep }, null, 2) + "\n");
  process.exit(0);
}
if (done) console.log(`This database was migrated on ${done.value}; anything listed below is left over from it.`);
if (!rep.events.length) { console.log("Nothing to copy: no event holds a bank question."); process.exit(0); }
for (const e of rep.events) {
  const rows = MOVED_TABLES.map(t => `${t} ${e.rows[t]}`).join(", ");
  console.log(`${e.name} (${e.competition_id}): ${e.questions} question(s) copied; rows moved: ${rows}`);
}
console.log(`Total: ${rep.questions} question(s) in ${rep.events.length} event(s); rows moved: ` + MOVED_TABLES.map(t => `${t} ${rep.rows[t]}`).join(", "));
