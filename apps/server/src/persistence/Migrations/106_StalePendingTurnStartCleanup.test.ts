import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "106_StalePendingTurnStartCleanup",
  (it) => {
    it.effect("removes only the stranded pending turn-start shape, twice safely", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 105 });
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
          VALUES ('thread-a', NULL, 'message-steered', 'pending', '2026-10-10T09:00:00.000Z', '[]')`;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
          VALUES ('thread-a', 'turn-done', 'message-own', 'completed', '2026-10-10T08:59:00.000Z', '2026-10-10T08:59:00.000Z', '2026-10-10T09:01:00.000Z', '[]')`;
        // A checkpoint row also has turn_id NULL and may sit in 'pending';
        // its checkpoint_turn_count keeps it out of the cleanup.
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_files_json)
          VALUES ('thread-b', NULL, 'pending', '2026-10-10T09:02:00.000Z', 3, '[]')`;
        yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
          VALUES ('thread-b', 'turn-running', 'message-live', 'running', '2026-10-10T09:03:00.000Z', '2026-10-10T09:03:00.000Z', '[]')`;

        yield* runMigrations({ toMigrationInclusive: 106 });
        yield* runMigrations({ toMigrationInclusive: 106 });

        const rows = yield* sql<{
          readonly threadId: string;
          readonly turnId: string | null;
          readonly state: string;
        }>`
          SELECT thread_id AS "threadId", turn_id AS "turnId", state
          FROM projection_turns
          ORDER BY thread_id, requested_at
        `;
        expect(rows).toEqual([
          { threadId: "thread-a", turnId: "turn-done", state: "completed" },
          { threadId: "thread-b", turnId: null, state: "pending" },
          { threadId: "thread-b", turnId: "turn-running", state: "running" },
        ]);
      }),
    );
  },
);
