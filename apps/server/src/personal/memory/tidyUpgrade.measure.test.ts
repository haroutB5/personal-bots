// What the 1.60.42 startup does to the changes that were waiting on the live database: measured on
// a read-only backup, replayed into an in-memory database, counts only (no memory text is printed).
// Off unless HBOTS_TIDY_UPGRADE_DB names a backup's state.sqlite.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { layer as memoryLayer } from "./PersonalMemoryService.ts";
import {
  PersonalMemoryTidy,
  PersonalMemoryTidyJudge,
  layer as tidyLayer,
} from "./PersonalMemoryTidyService.ts";

const LIVE_DB = process.env.HBOTS_TIDY_UPGRADE_DB;
const OUT = process.env.HBOTS_TIDY_UPGRADE_OUT;

const judge = Layer.succeed(PersonalMemoryTidyJudge, {
  model: "none",
  judge: () => Effect.succeed({ decisions: [] }),
});
const TestLayer = Layer.mergeAll(tidyLayer.pipe(Layer.provide(judge)), memoryLayer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const TABLES = [
  "personal_memory",
  "personal_memory_tidy_runs",
  "personal_memory_tidy_changes",
  "personal_memory_tidy_settings",
] as const;

describe.skipIf(LIVE_DB === undefined)("the startup settle on the live data", () => {
  it.effect("applies, leaves or withdraws what waited", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const live = new NodeSqlite.DatabaseSync(LIVE_DB!, { readOnly: true });
      live.exec("PRAGMA query_only=1");
      for (const table of TABLES) {
        const columns = (yield* sql<{
          readonly name: string;
        }>`SELECT name FROM pragma_table_info(${table})`).map((row) => row.name);
        const liveColumns = (
          live.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        ).map((column) => column.name);
        const shared = columns.filter((name) => liveColumns.includes(name));
        yield* sql`DELETE FROM ${sql(table)}`;
        for (const row of live.prepare(`SELECT ${shared.join(", ")} FROM ${table}`).all() as Array<
          Record<string, string | number | null>
        >) {
          const values = shared.map((name) => row[name] ?? null);
          yield* sql.unsafe(
            `INSERT INTO ${table} (${shared.join(", ")}) VALUES (${shared.map(() => "?").join(", ")})`,
            values,
          );
        }
      }
      live.close();

      const count = (label: string) =>
        sql<{ readonly status: string; readonly action: string; readonly n: number }>`
          SELECT status, action, COUNT(*) AS n FROM personal_memory_tidy_changes
          GROUP BY status, action ORDER BY status, action
        `.pipe(
          Effect.map((rows) => ({
            label,
            rows: rows.map((row) => `${row.status}/${row.action}=${row.n}`),
          })),
        );
      const before = yield* count("before");
      const tidy = yield* PersonalMemoryTidy;
      const modeBefore = (yield* tidy.log({})).mode;
      const started = performance.now();
      const settled = yield* tidy.applyWaiting;
      const took = Math.round(performance.now() - started);
      const after = yield* count("after");
      const modeAfter = (yield* tidy.log({})).mode;
      const undoable = (yield* tidy.log({ limit: 60 })).runs
        .flatMap((run) => run.changes)
        .filter((change) => change.undoable === true).length;
      const text = [
        `mode ${modeBefore} -> ${modeAfter}`,
        `settled ${settled.applied} applied, ${settled.left} left (stale), ${settled.withdrawn} withdrawn in ${took} ms`,
        `undoable in the log now: ${undoable}`,
        ...[before, after].map((entry) => `${entry.label}: ${entry.rows.join(" ")}`),
      ].join("\n");
      if (OUT !== undefined) NodeFS.writeFileSync(OUT, `${text}\n`);
      yield* Effect.logInfo(text);
    }).pipe(Effect.provide(TestLayer)),
  );
});
