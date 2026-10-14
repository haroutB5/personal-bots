import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * `PRAGMA synchronous` for the server's connection. SQLite runs on the main thread, so
 * the default (FULL: fsync the -wal file on every commit) stops the event loop for as
 * long as the disk takes, and a busy disk (an install, a build, a scan) makes that
 * seconds: 5 of 5 runs of a 30 s write test under disk load had a commit over 1 s,
 * median 5.9 s of the loop blocked. NORMAL (fsync only when a checkpoint runs) cut that
 * to 1 of 5 and a median of 1.7 s. A crash of the server loses nothing either way; only
 * a power cut or OS crash can lose the last commits, and the database stays consistent.
 * `T3CODE_SQLITE_SYNCHRONOUS=full` restores FULL.
 */
export const sqliteSynchronousFromEnv = (value: string | undefined): "NORMAL" | "FULL" => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "full" || normalized === "2" || normalized === "extra" ? "FULL" : "NORMAL";
};

export const SQLITE_CACHE_DEFAULT_MB = 64;
const SQLITE_CACHE_MAX_MB = 1024;

/**
 * Page cache of the server's connection, in MiB (`PRAGMA cache_size`). Every orchestration
 * command probes a random leaf of each big UUID-keyed index (command receipts, event ids,
 * event command ids and correlation ids: about 280 MB on the 14 Oct production copy). With
 * SQLite's default 2 MiB cache nearly every probe is a file read on the main thread, and
 * while the disk is busy one read can wait for seconds: on 14 Oct a 10.3 s receipt lookup
 * (`getByCommandId`, a primary-key search) sat inside a 19.1 s stall. 64 MiB keeps the inner
 * pages and recent leaves in memory: on the production copy a replay of 2,000 commands read
 * 29 KB per command with the default cache and 12 KB with 64 MiB, and the receipt lookup
 * alone 6.2 KB and 1.6 KB. `T3CODE_SQLITE_CACHE_MB=off` (or 0) keeps SQLite's default; a
 * whole number from 1 to 1024 sets the size.
 */
export const sqliteCacheMbFromEnv = (value: string | undefined): number | null => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return SQLITE_CACHE_DEFAULT_MB;
  if (["off", "0", "false", "no", "default"].includes(normalized)) return null;
  const mb = Number(normalized);
  return Number.isInteger(mb) && mb >= 1 && mb <= SQLITE_CACHE_MAX_MB
    ? mb
    : SQLITE_CACHE_DEFAULT_MB;
};

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql.unsafe(
      `PRAGMA synchronous = ${sqliteSynchronousFromEnv(process.env.T3CODE_SQLITE_SYNCHRONOUS)};`,
    );
    const cacheMb = sqliteCacheMbFromEnv(process.env.T3CODE_SQLITE_CACHE_MB);
    if (cacheMb !== null) {
      // Negative = KiB, so the size does not depend on the page size.
      yield* sql.unsafe(`PRAGMA cache_size = -${cacheMb * 1024};`);
    }
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
  }),
);

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    setup,
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);
