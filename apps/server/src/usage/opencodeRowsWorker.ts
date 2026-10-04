/**
 * Source of the worker thread that reads OpenCode's message rows, kept as plain
 * JavaScript text so the bundled server can start it with
 * `new Worker(source, { eval: true })` (the same arrangement as the stall
 * watchdog's worker; a worker needs a file of its own otherwise).
 *
 * Why a thread at all: `node:sqlite` is synchronous, and OpenCode's store is a
 * database of about 2 GB. Walking its message table is mostly page reads, which
 * cannot be sliced from JavaScript: with the pages out of the OS cache one step
 * held the server's event loop for over 500 ms. On a thread of its own the
 * same walk costs the main thread nothing.
 *
 * The worker only fetches: for each database it runs the SELECT the reader
 * built (token fields only, never a message body) and posts the rows back. The
 * reader parses them, de-duplicates and aggregates on the main thread, in
 * slices, so the rules live in one place.
 *
 * Input (`workerData`): `{ root, names, sinceMs, fieldsSql, maxRowChars }`.
 * Output (one message): `[{ name, error, rows: [id, sessionId, fields, created][] }]`.
 */
export const OPENCODE_ROWS_WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const { root, names, sinceMs, fieldsSql, maxRowChars } = workerData;
const results = [];
for (const name of names) {
  const entry = { name, error: false, rows: [] };
  let database;
  try {
    database = new DatabaseSync(path.join(root, name), { readOnly: true });
    // A busy live provider should fail this source promptly rather than wait for its writer.
    database.exec("PRAGMA busy_timeout = 100");
    const tables = new Set(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    );
    if (!tables.has("message") && !tables.has("session_message")) entry.error = true;
    for (const table of ["message", "session_message"]) {
      if (!tables.has(table)) continue;
      const columns = new Set(
        database.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name),
      );
      const timestamp = columns.has("time_created") ? "time_created" : "NULL";
      const predicates =
        table === "session_message" ? ["type = 'assistant'"] : ["length(data) <= " + maxRowChars];
      if (timestamp !== "NULL") predicates.push("time_created >= ?");
      const where = predicates.length > 0 ? " WHERE " + predicates.join(" AND ") : "";
      const statement = database.prepare(
        "SELECT id, session_id, " + fieldsSql + " AS fields, " + timestamp + " AS created FROM " + table + where,
      );
      for (const row of statement.iterate(...(timestamp === "NULL" ? [] : [sinceMs]))) {
        entry.rows.push([row.id, row.session_id, row.fields, row.created]);
      }
    }
  } catch {
    entry.error = true;
  } finally {
    if (database) database.close();
  }
  results.push(entry);
}
parentPort.postMessage(results);
`;

/** One database's rows as the worker posts them. */
export interface OpenCodeRowsResult {
  readonly name: string;
  readonly error: boolean;
  readonly rows: ReadonlyArray<readonly [unknown, unknown, unknown, unknown]>;
}
