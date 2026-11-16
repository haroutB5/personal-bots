// A tiny stand-in for state.sqlite (WAL mode) for throwaway fixtures and the guards' backup proof.
// Library: makeFixtureDb(file, maxMigration). CLI: node fixture.mjs <file> <maxMigration>
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";

export function makeFixtureDb(file, maxMigration) {
  if (!Number.isInteger(maxMigration) || maxMigration < 1)
    throw new Error("maxMigration must be a positive integer");
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)",
    );
    db.exec(
      "CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, body TEXT)",
    );
    db.exec("CREATE TABLE personal_memory (id TEXT PRIMARY KEY, body TEXT)");
    const mig = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?, ?)");
    for (let i = 1; i <= maxMigration; i++) mig.run(i, "2026-01-01T00:00:00Z", `fixture_${i}`);
    const messages = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?)");
    for (let i = 0; i < 25; i++) messages.run(`a${i}`, "x".repeat(200));
    const mem = db.prepare("INSERT INTO personal_memory VALUES (?, ?)");
    for (let i = 0; i < 7; i++) mem.run(`m${i}`, "fixture");
  } finally {
    db.close();
  }
}

if (
  process.argv[1] &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  makeFixtureDb(process.argv[2], Number(process.argv[3] || 1));
  console.log("fixture ok");
}
