import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqlite from "node:sqlite";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(6291456))`;
    yield* sql`DROP TABLE discarded`;
    const before = yield* freePages;
    assert.isAbove(before, 1024);
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    yield* storage.reclaim.pipe(Effect.withTracer(tracer), Effect.withTracerEnabled(true));
    assert.equal(before - (yield* freePages), 1024);
    assert.lengthOf(spans, 1);
    assert.deepEqual(
      spans.map((span) => span.name),
      ["DatabaseStorage.reclaim"],
    );
    assert.equal(spans[0]?.attributes.get("db.reclaimed_pages"), 1024);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

const compactionLayer = (
  pruneEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["pruneEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        pruneEventStore,
      }),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = {
  deletedEventCount: 0,
  deletedReceiptCount: 0,
  reclaimableBytes: 0,
  drained: true,
};

it.effect("remembers completion only after the paced pass finishes", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const betweenPagesReached = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const timestampWritten = yield* Deferred.make<void>();
    const compact = (betweenPages: Effect.Effect<void> = Effect.void) =>
      Effect.gen(function* () {
        yield* Effect.sleep(30);
        yield* Deferred.succeed(betweenPagesReached, undefined);
        yield* betweenPages;
        yield* Deferred.succeed(completed, undefined);
        return emptyCompaction;
      });
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* TestClock.adjust(30);
      yield* Deferred.await(betweenPagesReached);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(269);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* fs.exists(timestampPath));
      yield* TestClock.adjust(1);
      yield* Deferred.await(timestampWritten);
      assert.isTrue(yield* Deferred.isDone(completed));
      assert.equal(Number(yield* fs.readFileString(timestampPath)), startupTime + minute + 300);
    }).pipe(
      Effect.provide(compactionLayer(compact)),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.ensuring(Deferred.succeed(timestampWritten, undefined))),
      }),
    );
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

const fileStorageLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return DatabaseStorage.layer.pipe(
      Layer.provideMerge(ProjectionMaintenance.layer),
      Layer.provideMerge(Sqlite.layerFromPath(config.dbPath)),
    );
  }),
).pipe(Layer.provideMerge(testConfig), Layer.provideMerge(NodeServices.layer));

const seedLegacyImport = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports (
        thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count
      ) VALUES ('thread:storage-legacy', '2026-10-17', '2026-10-17', '2026-10-17', 0)
    `;
    for (let index = 1; index <= count; index += 1) {
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`event:storage-legacy:${index}`}, 'thread', 'thread:storage-legacy', ${index},
          'message.updated', '2026-10-17T00:00:00.000Z', 'server', '{"text":"legacy"}', '{}', 1
        )
      `;
    }
  });

it.live("retries a batch that loses the write lock and records completion", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");

      yield* seedLegacyImport(120);
      yield* sql`PRAGMA busy_timeout = 100`;

      const locker = new NodeSqlite.DatabaseSync(config.dbPath);
      yield* Effect.addFinalizer(() => Effect.sync(() => locker.close()));
      locker.exec("PRAGMA busy_timeout = 0");
      locker.exec("BEGIN IMMEDIATE");

      // The first writer statement hits the held lock and fails with a timeout.
      // Releasing it on the retry proves the batch survived that failure.
      let writerAttempts = 0;
      const releaseOnRetry: Statement.Transformer = (statement) => {
        const [rawQuery] = statement.compile();
        const query = rawQuery.trimStart();
        if (
          query.startsWith("INSERT INTO orchestration_v2_projection_metadata") ||
          query.startsWith("DELETE FROM orchestration_events") ||
          query.startsWith("DELETE FROM orchestration_command_receipts")
        ) {
          writerAttempts += 1;
          if (writerAttempts === 2) locker.exec("COMMIT");
        }
        return Effect.succeed(statement);
      };

      const result = yield* DatabaseStorage.runCompaction(
        maintenance,
        timestampPath,
        Effect.void,
      ).pipe(Effect.provideService(Statement.CurrentTransformer, releaseOnRetry));
      assert.isAbove(writerAttempts, 2);
      assert.isTrue(result.drained);
      assert.equal(result.deletedEventCount, 120);
      assert.isTrue(yield* fs.exists(timestampPath));
      assert.deepEqual(
        yield* sql`SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = 'thread:storage-legacy'`,
        [{ count: 0 }],
      );
    }),
  ).pipe(Effect.provide(fileStorageLayer)),
);

it.effect("records completion when the last legacy page ends below the head", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");

    // A full legacy page, then a partial page whose last v1 sequence sits below
    // a newer v2 head. The old cursor stopped at 120 and never reached 121.
    yield* seedLegacyImport(120);
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        'event:storage-v2-head', 'thread', 'thread:storage-v2', 1,
        'message.updated', '2026-10-17T00:00:00.000Z', 'server', '{"text":"v2"}', '{}', 2
      )
    `;

    const result = yield* DatabaseStorage.runCompaction(maintenance, timestampPath, Effect.void);

    assert.isTrue(result.drained);
    assert.equal(result.deletedEventCount, 120);
    assert.isTrue(yield* fs.exists(timestampPath));
  }).pipe(Effect.provide(fileStorageLayer)),
);

it.effect("does not record completion when the pass reports a backlog", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    const ran = yield* Deferred.make<void>();
    const backlogged = () =>
      Deferred.succeed(ran, undefined).pipe(Effect.as({ ...emptyCompaction, drained: false }));
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(minute);
      yield* Deferred.await(ran);
      assert.isFalse(yield* fs.exists(timestampPath));
    }).pipe(Effect.provide(compactionLayer(backlogged)));
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

// NONE is a database from before automatic shrinking, which the repair converts.
const reclaimLayer = (
  restart: Effect.Effect<void> | null,
  autoVacuum: "NONE" | "FULL" | "INCREMENTAL" = "NONE",
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.succeed(DatabaseStorage.ServerRestart, restart)),
    Layer.provide(
      Layer.effectDiscard(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe(`PRAGMA auto_vacuum = ${autoVacuum}`);
          yield* sql`VACUUM`;
        }),
      ).pipe(Layer.provideMerge(Sqlite.layerMemory)),
    ),
  );

it.effect(
  "a reclaim from Settings saves its request, then restarts the server after replying",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const files = DatabaseMaintenance.reclaimFiles(path, config.dbPath);
      const request = Effect.flatMap(
        DatabaseStorage.DatabaseStorage,
        (storage) => storage.requestReclaim,
      );
      const restarted = yield* Deferred.make<void>();
      const restart = Deferred.succeed(restarted, undefined).pipe(Effect.asVoid);

      // Nothing starts a server run by hand again, so it keeps pointing at the command.
      const unsupervised = yield* request.pipe(Effect.flip, Effect.provide(reclaimLayer(null)));
      assert.equal(unsupervised._tag, "DatabaseReclaimError");
      // A database that already shrinks on its own (or a stale dialog after another client's
      // repair) has nothing to reclaim, so it must not restart.
      for (const autoVacuum of ["FULL", "INCREMENTAL"] as const) {
        const refused = yield* request.pipe(
          Effect.flip,
          Effect.provide(reclaimLayer(restart, autoVacuum)),
        );
        assert.equal(refused._tag, "DatabaseReclaimError", autoVacuum);
      }
      assert.isFalse(yield* fs.exists(files.request));

      yield* fs.writeFileString(files.failure, "an earlier failure");
      yield* Effect.gen(function* () {
        const storage = yield* DatabaseStorage.DatabaseStorage;
        const shownFailure = storage.status.pipe(
          Stream.filter((status) => status !== null),
          Stream.runHead,
          Effect.map((status) => Option.getOrThrow(status)?.reclaimFailure),
        );
        assert.equal(yield* shownFailure, "an earlier failure");
        yield* storage.requestReclaim;
        // The retry clears it at once, so Settings shows the restart, not the old failure.
        assert.isUndefined(yield* shownFailure);
      }).pipe(Effect.provide(reclaimLayer(restart)));
      assert.isTrue(yield* fs.exists(files.request));
      assert.isFalse(yield* fs.exists(files.failure));
      assert.isFalse(yield* Deferred.isDone(restarted), "the reply must go out before the restart");
      yield* TestClock.adjust(500);
      yield* Deferred.await(restarted);
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);
