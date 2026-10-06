import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("101_PersonalModelFallback", (it) => {
  it.effect(
    "fallback is on for existing bots, with no model of its own, and nobody is switched",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 100 });
        yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, enabled, sort_order, created_at, updated_at, deleted_at
        )
        VALUES (
          'it', 'IT', '', '', 'blob', '#1A73E8',
          '{"instanceId":"codex","model":"gpt-6.1-sol"}', 1, 0,
          '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z', NULL
        )
      `;
        yield* sql`
        INSERT INTO personal_chat_resumes (
          resume_id, thread_id, hit_key, provider, hit_at, status
        )
        VALUES ('r1', 't1', 'k1', 'codex', '2026-10-05T00:00:00.000Z', 'skipped')
      `;

        yield* runMigrations({ toMigrationInclusive: 101 });
        const bots = yield* sql<{ readonly on: number; readonly model: string | null }>`
        SELECT fallback_enabled AS "on", fallback_model_json AS "model"
        FROM personal_bots WHERE bot_id = 'it'
      `;
        assert.deepEqual(bots, [{ on: 1, model: null }]);
        const active = yield* sql<{ readonly n: number }>`
        SELECT count(*) AS "n" FROM personal_bot_fallbacks
      `;
        assert.deepEqual(active, [{ n: 0 }]);
        const resumes = yield* sql<{ readonly fallback: number }>`
        SELECT fallback FROM personal_chat_resumes WHERE resume_id = 'r1'
      `;
        assert.deepEqual(resumes, [{ fallback: 0 }]);
      }),
  );
});
