import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const AT = "2026-11-15T10:00:00.000Z";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "159_PersonalProjectsWhyHistory",
  (it) => {
    it.effect("keeps existing project rows and gives them a null why and an empty history", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 158 });
        yield* sql`
          INSERT INTO personal_projects (
            project_id, lead_bot_id, thread_id, name, steps_json, due_at, estimated_at,
            state, closed_at, created_at, updated_at
          )
          VALUES (
            'p1', 'lead', NULL, 'Kino', '[{"label":"Build","state":"doing"}]',
            NULL, NULL, 'open', NULL, ${AT}, ${AT}
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 159 });

        const rows = yield* sql<{
          readonly projectId: string;
          readonly name: string;
          readonly why: string | null;
          readonly history: string;
        }>`
          SELECT project_id AS "projectId", name AS "name", why AS "why",
                 history_json AS "history"
          FROM personal_projects
        `;
        assert.deepStrictEqual(rows, [{ projectId: "p1", name: "Kino", why: null, history: "[]" }]);
        const integrity = yield* sql<{ readonly integrity_check: string }>`
          PRAGMA integrity_check
        `;
        assert.strictEqual(integrity[0]?.integrity_check, "ok");
      }),
    );
  },
);
