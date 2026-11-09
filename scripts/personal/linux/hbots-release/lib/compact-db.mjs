// VACUUMs one stopped hbots state database in a child process, so the runner can kill a stuck run.
// The caller (lib/compact.mjs) has already stopped the service, checked for holders, taken and verified the
// backup, and set SQLITE_TMPDIR to a directory on the same disk. This file never starts or stops anything.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

const BOOTSTRAP_PREFIX_WHITESPACE =
  "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const ATTACHMENT_ONLY_BOOTSTRAP_PROMPT =
  "[User attached one or more files without additional text. Respond using the conversation context and the attached files.]";

const database = NodePath.resolve(String(process.argv[2] ?? ""));
if (!process.argv[2]) throw new Error("usage: compact-db.mjs <database>");
if (!process.env.SQLITE_TMPDIR || !NodeFS.existsSync(process.env.SQLITE_TMPDIR))
  throw new Error("SQLITE_TMPDIR must name an existing directory on a disk");

const progress = (text) => process.stderr.write(`${text}\n`);

function assertSqliteFile(file) {
  const head = Buffer.alloc(16);
  const fd = NodeFS.openSync(file, "r");
  try {
    NodeFS.readSync(fd, head, 0, 16, 0);
  } finally {
    NodeFS.closeSync(fd);
  }
  if (head.toString("latin1") !== "SQLite format 3\0") throw new Error(`${file} is not a SQLite database`);
}

function holdersOf(file) {
  const names = new Set([file, `${file}-wal`, `${file}-shm`, `${file}-journal`]);
  const holders = [];
  for (const name of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let fds;
    try {
      fds = NodeFS.readdirSync(`/proc/${name}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (names.has(NodeFS.readlinkSync(`/proc/${name}/fd/${fd}`))) {
          holders.push(Number(name));
          break;
        }
      } catch {}
    }
  }
  return holders;
}

const state = {
  database: NodePath.basename(database),
  ok: false,
  stages: {},
};
let db = null;
let stage = "start";

try {
  if (!NodeFS.existsSync(database)) throw new Error(`${database} does not exist`);
  assertSqliteFile(database);
  const holders = holdersOf(database);
  if (holders.length) throw new Error(`pid(s) ${holders.join(",")} still hold the database open`);

  const started = process.hrtime.bigint();
  state.beforeBytes = NodeFS.statSync(database).size;
  progress(`opening ${database} (${state.beforeBytes} bytes)`);
  db = new DatabaseSync(database, { allowExtension: false });
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("PRAGMA temp_store = FILE");
  db.exec("PRAGMA cache_size = -65536");
  const pragma = (name) => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];

  stage = "checkpoint";
  const checkpoint0 = process.hrtime.bigint();
  const before = Object.values(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
  if (Number(before[0]) !== 0) throw new Error(`WAL is busy (${before.join(",")}); another connection holds it`);
  state.beforePageCount = Number(pragma("page_count"));
  state.freelistBefore = Number(pragma("freelist_count"));
  state.pageSize = Number(pragma("page_size"));
  state.autoVacuumBefore = Number(pragma("auto_vacuum"));
  state.checkpointBytes = NodeFS.statSync(database).size;
  state.stages.checkpoint = Math.round(Number(process.hrtime.bigint() - checkpoint0) / 1e8) / 10;
  progress(`checkpoint: pages ${state.beforePageCount}, free ${state.freelistBefore}, auto_vacuum ${state.autoVacuumBefore}`);

  stage = "vacuum";
  const vacuum0 = process.hrtime.bigint();
  db.exec("PRAGMA auto_vacuum = INCREMENTAL");
  db.exec("VACUUM");
  state.stages.vacuum = Math.round(Number(process.hrtime.bigint() - vacuum0) / 1e8) / 10;
  state.afterVacuumBytes = NodeFS.statSync(database).size;
  progress(`vacuum: ${state.checkpointBytes} -> ${state.afterVacuumBytes} bytes in ${state.stages.vacuum} s`);

  // Test-only synthetic failure after the rewrite, so the runner's restore path can be proven.
  if (process.env.HBOTS_RELEASE_TEST === "1" && process.env.HBOTS_RELEASE_TEST_COMPACT_FAIL === "after-vacuum")
    throw new Error("forced compact failure after VACUUM (test)");

  stage = "search-index";
  const hasIndex = Number(
    db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'orchestration_v2_message_search'").get().n,
  );
  if (hasIndex) {
    const index0 = process.hrtime.bigint();
    // Mirrors rebuildMessageSearch in apps/server/src/orchestration-v2/messageSearchIndex.ts: VACUUM can
    // renumber message rowids, and the FTS index is keyed by rowid.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        "INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search) VALUES ('delete-all')",
      );
      db.exec(`INSERT INTO orchestration_v2_message_search (rowid, text)
        SELECT messages.rowid,
          replace(replace(json_extract(messages.payload_json, '$.text'), char(8217), ''''), char(8216), '''')
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.streaming = 0
          AND (
            messages.role = 'assistant'
            OR (
              messages.role = 'user'
              AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
            )
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_threads AS subagent_threads
            WHERE subagent_threads.thread_id = messages.thread_id
              AND json_extract(subagent_threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          )
          AND (CASE
            WHEN substr(json_extract(messages.payload_json, '$.text'), 1, 11) = 'Ultrathink:' COLLATE NOCASE
              THEN ltrim(substr(json_extract(messages.payload_json, '$.text'), 12), '${BOOTSTRAP_PREFIX_WHITESPACE}')
            ELSE json_extract(messages.payload_json, '$.text')
          END COLLATE BINARY <> '${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT.replaceAll("'", "''")}')
          AND json_extract(messages.payload_json, '$.text') IS NOT NULL`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
    state.stages.searchIndex = Math.round(Number(process.hrtime.bigint() - index0) / 1e8) / 10;
    progress(`search index rebuilt in ${state.stages.searchIndex} s`);
  } else {
    state.stages.searchIndex = 0;
    progress("search index absent; skipped");
  }

  stage = "check";
  const check0 = process.hrtime.bigint();
  const verdicts = db
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => String(Object.values(row)[0]));
  state.check = "quick_check";
  state.checkResult = verdicts.length === 1 && verdicts[0] === "ok" ? "ok" : verdicts.join("; ").slice(0, 500);
  state.stages.check = Math.round(Number(process.hrtime.bigint() - check0) / 1e8) / 10;
  if (state.checkResult !== "ok") throw new Error(`quick_check failed: ${state.checkResult}`);
  progress(`quick_check ok in ${state.stages.check} s`);

  stage = "final-checkpoint";
  const after = Object.values(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get());
  if (Number(after[0]) !== 0) throw new Error(`final WAL checkpoint is busy (${after.join(",")})`);
  state.afterPageCount = Number(pragma("page_count"));
  state.freelistAfter = Number(pragma("freelist_count"));
  state.autoVacuum = Number(pragma("auto_vacuum"));
  state.afterBytes = NodeFS.statSync(database).size;
  state.seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e8) / 10;
  state.ok = true;
  progress(
    `done: ${state.beforeBytes} -> ${state.afterBytes} bytes, free ${state.freelistAfter}/${state.afterPageCount}, auto_vacuum ${state.autoVacuum}, ${state.seconds} s`,
  );
} catch (error) {
  state.error = `${stage}: ${String(error?.message ?? error)}`.slice(0, 800);
  progress(`FAILED ${state.error}`);
  process.exitCode = 1;
} finally {
  try {
    db?.close();
  } catch {}
  process.stdout.write(`${JSON.stringify(state)}\n`);
}
