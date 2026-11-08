import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { sqliteWorkerEnabled } from "@t3tools/shared/nodeSqliteWorker";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import {
  sqliteCheckpointWorkerEnabled,
  startSqliteCheckpointWorker,
} from "./sqliteCheckpointWorker.ts";
import * as ServerConfig from "../config.ts";

const WAL_SIZE_LIMIT_BYTES = 128 * 1024 * 1024;

/** FULL fsyncs every commit on the main thread, so a busy disk blocks it; NORMAL fsyncs at checkpoints and a power cut can lose only post-checkpoint commits. `T3CODE_SQLITE_SYNCHRONOUS=full` restores FULL. */
export const sqliteSynchronousFromEnv = (value: string | undefined): "NORMAL" | "FULL" => {
  const normalized = value?.trim().toLowerCase();
  return normalized === "full" || normalized === "2" || normalized === "extra" ? "FULL" : "NORMAL";
};

export const SQLITE_CACHE_DEFAULT_MB = 64;
const SQLITE_CACHE_MAX_MB = 1024;

/** 64 MiB of page cache keeps the big UUID index leaves in memory, where the default 2 MiB reads them from disk on every command. `T3CODE_SQLITE_CACHE_MB=off` keeps SQLite's default and a size from 1 to 1024 sets it. */
export const sqliteCacheMbFromEnv = (value: string | undefined): number | null => {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return SQLITE_CACHE_DEFAULT_MB;
  if (["off", "0", "false", "no", "default"].includes(normalized)) return null;
  const mb = Number(normalized);
  return Number.isInteger(mb) && mb >= 1 && mb <= SQLITE_CACHE_MAX_MB
    ? mb
    : SQLITE_CACHE_DEFAULT_MB;
};

const layerSetup = (worker: boolean, dbPath?: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      // Existing databases need doctor's offline VACUUM to add pointer maps for this mode.
      const tables = yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
      if (tables[0]?.count === 0) yield* sql`PRAGMA auto_vacuum = INCREMENTAL;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // FULL fsyncs every event commit on the main thread; NORMAL syncs only at WAL checkpoints.
      // App crashes lose nothing; OS crashes or power loss can roll back post-checkpoint commits without corruption.
      yield* sql.unsafe(
        `PRAGMA synchronous = ${sqliteSynchronousFromEnv(process.env.T3CODE_SQLITE_SYNCHRONOUS)};`,
      );
      // macOS fsync misses drive caches; F_FULLFSYNC flushes them at checkpoints and is ignored elsewhere.
      yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
      // Keep statement journals and sort spills off the main thread's disk path.
      // Large statements and open savepoints can increase peak memory use.
      yield* sql`PRAGMA temp_store = MEMORY;`;
      const cacheMb = sqliteCacheMbFromEnv(process.env.T3CODE_SQLITE_CACHE_MB);
      if (cacheMb !== null) {
        // Negative = KiB, so the size does not depend on the page size.
        yield* sql.unsafe(`PRAGMA cache_size = -${cacheMb * 1024};`);
      }
      // PASSIVE checkpoints retain peak WAL size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* runMigrations();
      if (worker && sqliteCheckpointWorkerEnabled(process.env.T3CODE_SQLITE_CHECKPOINT_WORKER)) {
        const restore = sql`PRAGMA wal_autocheckpoint = 1000`.pipe(
          Effect.tap(() =>
            Effect.logWarning(
              "SQLite checkpoint worker unavailable; restored main-thread auto-checkpoints",
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("Failed to restore SQLite auto-checkpoints", cause),
          ),
        );
        const checkpoint = yield* Effect.acquireRelease(
          Effect.promise(() =>
            startSqliteCheckpointWorker({
              filename: dbPath!,
              synchronous: sqliteSynchronousFromEnv(process.env.T3CODE_SQLITE_SYNCHRONOUS),
              onFailure: () => {
                Effect.runFork(restore);
              },
              onWarning: (message) => {
                Effect.runFork(Effect.logWarning(message));
              },
              onCheckpoint: (result) => {
                if (result.ms >= 1000)
                  Effect.runFork(Effect.logWarning("SQLite background checkpoint", result));
              },
            }),
          ),
          (handle) => Effect.promise(() => handle.stop()),
        );
        if (checkpoint.active) {
          yield* sql`PRAGMA wal_autocheckpoint = 0`;
          // Failure can race startup; never leave the writer without a checkpointer.
          if (!checkpoint.active) yield* restore;
        }
      }
      // Collecting stats scans every page, and stale small-table stats cause scans after growth; use indexes by default.
      // Connections cache stats; reload after deleting them.
      const statTables = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'`;
      if (statTables.length > 0) {
        yield* sql`DELETE FROM sqlite_stat1;`;
        yield* sql`ANALYZE sqlite_schema;`;
      }
    }).pipe(Effect.withSpan("Sqlite.setup")),
  );

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
  // Read once at startup: one serialized worker owns the writer unless the
  // kill switch is set, and `off` restores the in-thread bridge exactly.
  const worker = sqliteWorkerEnabled(process.env.T3CODE_SQLITE_WORKER);
  yield* Effect.logInfo(
    `SQLite connection mode: ${worker ? "worker" : "inline"} (${path.basename(dbPath)})`,
  );

  return Layer.provideMerge(
    layerSetup(worker, dbPath),
    NodeSqliteClient.layer({
      filename: dbPath,
      worker,
      readerWorker: true,
      // The worker path starts persistence/sqliteCheckpointWorker.ts after
      // migrations; the inline path keeps its own admission-aware worker.
      checkpointWorker: !worker,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup(false),
  NodeSqliteClient.layer({ filename: ":memory:", worker: false }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
