import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("066_DropPersonalLoginGrants", (it) => {
  it.effect("drops the grant table and leaves the saved logins themselves untouched", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`
        INSERT INTO personal_logins (
          login_id, label, origin, username, secret_ref, created_at, updated_at
        ) VALUES (
          'login-1', 'Example', 'https://example.com', 'person@example.com', 'opaque-ref',
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO personal_bots (
          bot_id, name, description, instructions, avatar_shape, avatar_color,
          model_selection_json, created_at, updated_at
        ) VALUES (
          'bot-a', 'Assistant', '', '', 'blob', '#1A73E8',
          '{"instanceId":"codex","model":"gpt-test"}',
          '2026-09-14T00:00:00.000Z', '2026-09-14T00:00:00.000Z'
        )
      `;
      yield* sql`INSERT INTO personal_login_grants (login_id, bot_id) VALUES ('login-1', 'bot-a')`;

      yield* runMigrations({ toMigrationInclusive: 66 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'personal_login_grants'
      `;
      assert.deepEqual(tables, []);
      // The credential metadata is not what the decision removed.
      const logins = yield* sql<{ readonly label: string }>`
        SELECT label FROM personal_logins WHERE login_id = 'login-1'
      `;
      assert.deepEqual(logins, [{ label: "Example" }]);
    }),
  );
});
