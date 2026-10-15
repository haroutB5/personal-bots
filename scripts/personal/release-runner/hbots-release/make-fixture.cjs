// Builds a tiny stand-in for state.sqlite so the release runner can prove, before arming, that the copied tools'
// backup.ps1 and sqlite-snapshot.cjs work (VACUUM INTO + quick_check) and that release-db-check.cjs reads the result.
// Usage: node make-fixture.cjs <file> <maxMigration>
const { DatabaseSync } = require("node:sqlite");
const file = process.argv[2];
const maxMigration = Number(process.argv[3] || 1);
if (!file || !Number.isInteger(maxMigration) || maxMigration < 1) { console.error("usage: make-fixture.cjs <file> <maxMigration>"); process.exit(2); }
const db = new DatabaseSync(file);
try {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)");
  db.exec("CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, body TEXT)");
  db.exec("CREATE TABLE personal_memory (id TEXT PRIMARY KEY, body TEXT)");
  const mig = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?, ?)");
  for (let i = 1; i <= maxMigration; i++) mig.run(i, "2026-01-01T00:00:00Z", "fixture_" + i);
  const act = db.prepare("INSERT INTO projection_thread_activities VALUES (?, ?)");
  for (let i = 0; i < 25; i++) act.run("a" + i, "x".repeat(200));
  const mem = db.prepare("INSERT INTO personal_memory VALUES (?, ?)");
  for (let i = 0; i < 7; i++) mem.run("m" + i, "fixture");
} finally { db.close(); }
console.log("fixture ok");
