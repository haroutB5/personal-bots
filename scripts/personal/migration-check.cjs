// Reads the migration state of a SQLite database copy for restore-test.ps1:
// the highest applied migration id and whether named columns exist.
// Read-only. Usage:
//   PB_CHECK_DB=<state.sqlite> PB_CHECK_COLUMNS=table.column,... node migration-check.cjs
// Prints one JSON line: {"maxMigration":67,"columns":{"table.column":true}}
const { DatabaseSync } = require("node:sqlite");

const file = process.env.PB_CHECK_DB;
if (!file) {
  console.error("PB_CHECK_DB is required.");
  process.exit(2);
}
const wanted = (process.env.PB_CHECK_COLUMNS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const db = new DatabaseSync(file, { readOnly: true });
try {
  const row = db.prepare("SELECT max(migration_id) AS max FROM effect_sql_migrations").get();
  const columns = {};
  for (const entry of wanted) {
    const [table, column] = entry.split(".");
    const found = db
      .prepare("SELECT count(*) AS n FROM pragma_table_info(?) WHERE name = ?")
      .get(table, column);
    columns[entry] = Number(found?.n ?? 0) > 0;
  }
  console.log(JSON.stringify({ maxMigration: Number(row?.max ?? 0), columns }));
} finally {
  db.close();
}
