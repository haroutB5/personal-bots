// Usage: node mk-live-db.cjs <file> <maxMigration> <table.column,...>
const { DatabaseSync } = require('node:sqlite');
const [, , file, mig, colsCsv] = process.argv;
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, created_at TEXT, name TEXT)');
for (let i = 1; i <= Number(mig); i++) db.exec(`INSERT INTO effect_sql_migrations VALUES (${i}, 'x', 'm${i}')`);
db.exec('CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, body TEXT)');
for (let i = 0; i < 10; i++) db.exec(`INSERT INTO projection_thread_activities VALUES ('a${i}', 'x')`);
const tables = {};
for (const entry of (colsCsv || '').split(',').filter(Boolean)) {
  const [t, c] = entry.split('.');
  (tables[t] = tables[t] || new Set()).add(c);
}
if (!tables.personal_memory) tables.personal_memory = new Set();
for (const [t, cols] of Object.entries(tables)) {
  const defs = ['id TEXT PRIMARY KEY', ...[...cols].map((c) => `"${c}" TEXT`)];
  db.exec(`CREATE TABLE "${t}" (${defs.join(', ')})`);
}
for (let i = 0; i < 8; i++) db.exec(`INSERT INTO personal_memory (id) VALUES ('m${i}')`);
db.close();
