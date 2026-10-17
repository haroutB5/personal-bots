import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { clearStrandedTurnStarts } from "./strandedTurnStarts.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("clearStrandedTurnStarts", (it) => {
  it.effect("clears only the stranded turn-start shape, and is safe to run again", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({});
      // What a steered or queued message left behind when the process died
      // between its turn-start request and the turn starting.
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json)
        VALUES ('thread-a', NULL, 'message-stranded', 'pending', '2026-10-17T03:53:56.130Z', '[]')`;
      // A checkpoint row also has turn_id NULL and may sit in 'pending'.
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_files_json)
        VALUES ('thread-b', NULL, 'pending', '2026-10-17T03:53:56.130Z', 3, '[]')`;
      // A live turn owns its row.
      yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES ('thread-c', 'turn-running', 'message-live', 'running', '2026-10-17T03:53:56.130Z', '2026-10-17T03:53:56.130Z', '[]')`;

      expect(yield* clearStrandedTurnStarts()).toBe(1);
      expect(yield* clearStrandedTurnStarts()).toBe(0);

      const rows = yield* sql<{ readonly threadId: string; readonly state: string }>`
        SELECT thread_id AS "threadId", state FROM projection_turns ORDER BY thread_id
      `;
      expect(rows).toEqual([
        { threadId: "thread-b", state: "pending" },
        { threadId: "thread-c", state: "running" },
      ]);
    }),
  );
});
