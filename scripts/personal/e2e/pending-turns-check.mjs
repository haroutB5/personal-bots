// Check B's database half (driven by ../qa-16633.ps1 after steer-check.mjs):
// the throwaway DB must hold no pending turn-start row after a steered
// message, and the release's idle classifier must see the table (its audit
// prints pendingFresh/pendingStale, both 0 here). Exits non-zero on either.
//
// Usage: node pending-turns-check.mjs <state.sqlite> <idle-classification-.mjs> [--json]
import * as NodeFS from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const [dbPath, classifierPath] = args.filter((arg) => !arg.startsWith("--"));
if (!dbPath || !classifierPath) {
  throw new Error("usage: node pending-turns-check.mjs <state.sqlite> <idle-classification-.mjs>");
}
if (!NodeFS.existsSync(classifierPath)) throw new Error(`no classifier at ${classifierPath}`);
const classifier = await import(pathToFileURL(classifierPath).href);

const db = new DatabaseSync(dbPath, { readOnly: true });
let verdict;
let pending;
let turns;
try {
  pending = db
    .prepare(
      `SELECT p.thread_id AS threadId, p.pending_message_id AS messageId, p.requested_at AS requestedAt
       FROM projection_turns p
       WHERE p.turn_id IS NULL AND p.state = 'pending' AND p.checkpoint_turn_count IS NULL`,
    )
    .all();
  turns = db
    .prepare(
      `SELECT turn_id AS turnId, state, pending_message_id AS pendingMessageId
       FROM projection_turns ORDER BY requested_at`,
    )
    .all();
  verdict = classifier.classify(db);
} finally {
  db.close();
}

const result = { pendingRows: pending, turns, classifier: verdict };
if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`pending rows: ${pending.length}`);
  for (const row of pending) console.log(`  ${row.threadId} ${row.messageId} ${row.requestedAt}`);
  console.log(`turns: ${JSON.stringify(turns)}`);
  console.log(`classifier: ${JSON.stringify(verdict)}`);
}

const ok = pending.length === 0 && verdict.pendingFresh === 0 && verdict.pendingStale === 0;
console.log(ok ? "pending-turn check passed" : "pending-turn check FAILED");
process.exit(ok ? 0 : 1);
