import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { PersonalMemoryService } from "./PersonalMemoryService.ts";
import { personalMemoryTestLayer as memoryLayer } from "../test/personalReadsTestLayer.ts";

type Deadline<A> = { readonly kind: "done"; readonly value: A } | { readonly kind: "timeout" };

const beforeDeadline = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  ms: number,
): Effect.Effect<Deadline<A>, E, R> =>
  Effect.race(
    effect.pipe(Effect.map((value) => ({ kind: "done" as const, value }))),
    Effect.promise(
      () =>
        new Promise<Deadline<A>>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), ms)),
    ),
  );

const makeLayer = () => {
  const scratch = NodePath.join(process.cwd(), ".tmp");
  NodeFS.mkdirSync(scratch, { recursive: true });
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "j1a-readonly-"));
  const dbPath = NodePath.join(dir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  return memoryLayer.pipe(Layer.provideMerge(persistence));
};

it.live("reads memory while a writer transaction holds the database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memory = yield* PersonalMemoryService;
    yield* memory.save({
      scope: "shared",
      scopeId: null,
      kind: "note",
      source: "user",
      content: "j1a committed",
    });

    const warm = yield* beforeDeadline(NodeSqliteClient.readOnly(sql`SELECT 1 AS "one"`), 10_000);
    expect(warm.kind).toBe("done");

    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writer = yield* Effect.forkChild(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO personal_memory (
              memory_id, scope, scope_id, kind, content, source, sensitivity,
              created_at, updated_at, deleted_at, version
            )
            VALUES (
              'j1a-uncommitted', 'shared', NULL, 'note', 'j1a uncommitted', 'user', 'normal',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, 1
            )
          `;
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }),
      ),
    );

    yield* Deferred.await(started);
    const read = yield* beforeDeadline(NodeSqliteClient.readOnly(sql`SELECT 1 AS "one"`), 2_000);
    expect(read.kind).toBe("done");
    const found = yield* beforeDeadline(memory.search({ query: "j1a" }), 2_000);
    expect(found.kind).toBe("done");
    if (found.kind === "done") {
      expect(found.value.map((entry) => entry.content)).toEqual(["j1a committed"]);
    }

    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writer);
  }).pipe(Effect.provide(makeLayer()), Effect.scoped),
);
