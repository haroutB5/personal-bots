// Consistent SQLite snapshot for backup.ps1: VACUUM INTO from a read-only
// connection (safe while the server has the database open), then quick_check
// the copy. Paths come from the environment so PowerShell never has to quote
// JavaScript. Usage: PB_SNAPSHOT_SOURCE=... PB_SNAPSHOT_TARGET=... node sqlite-snapshot.cjs
const { DatabaseSync } = require("node:sqlite");

const source = process.env.PB_SNAPSHOT_SOURCE;
const target = process.env.PB_SNAPSHOT_TARGET;
if (!source || !target) {
  console.error("PB_SNAPSHOT_SOURCE and PB_SNAPSHOT_TARGET are required.");
  process.exit(2);
}

const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const copy = new DatabaseSync(target, { readOnly: true });
try {
  const verdict = Object.values(copy.prepare("PRAGMA quick_check").get() ?? {})[0];
  if (verdict !== "ok") {
    console.error(`quick_check failed: ${String(verdict)}`);
    process.exit(3);
  }
  const tables = copy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get();
  console.log(`snapshot ok (${String(tables?.n ?? 0)} tables)`);
} finally {
  copy.close();
}
