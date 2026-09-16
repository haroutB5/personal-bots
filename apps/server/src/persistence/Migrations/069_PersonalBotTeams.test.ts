import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

interface TeamRow {
  readonly name: string;
  readonly team: string;
  readonly is_lead: number;
  readonly pinned: number;
}

const insertBot = (sql: SqlClient.SqlClient, botId: string, name: string) => sql`
  INSERT INTO personal_bots (
    bot_id, name, description, instructions, avatar_shape, avatar_color,
    model_selection_json, created_at, updated_at
  ) VALUES (
    ${botId}, ${name}, '', '', 'blob', '#1A73E8',
    '{"instanceId":"codex","model":"gpt-test"}',
    '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z'
  )
`;

it.layer(NodeSqliteClient.layerMemory())("069_PersonalBotTeams", (it) => {
  it.effect("splits the existing bots into two teams with one lead each", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });

      // The owner's real roster, plus a bot on neither list and one whose name
      // differs only by case and padding.
      const roster = [
        ["bot-cto", "CTO"],
        ["bot-frontend", "Frontend"],
        ["bot-backend", "Backend"],
        ["bot-devops", "DevOps"],
        ["bot-qa", "QA"],
        ["bot-security", " security "],
        ["bot-assistant", "Assistant"],
        ["bot-planner", "Planner"],
        ["bot-scout", "Scout"],
        ["bot-musey", "Musey"],
      ] as const;
      for (const [botId, name] of roster) {
        yield* insertBot(sql, botId, name);
      }

      yield* runMigrations({ toMigrationInclusive: 69 });

      const rows = yield* sql<TeamRow>`
        SELECT name, team, is_lead, pinned FROM personal_bots ORDER BY bot_id ASC
      `;
      const byName = new Map(rows.map((row) => [row.name.trim(), row] as const));

      // The dev team: the CTO leads, the five engineers are members.
      assert.deepEqual(byName.get("CTO"), {
        name: "CTO",
        team: "dev",
        is_lead: 1,
        pinned: 1,
      });
      for (const name of ["Frontend", "Backend", "DevOps", "QA", "security"]) {
        assert.deepEqual(
          { team: byName.get(name)?.team, lead: byName.get(name)?.is_lead },
          { team: "dev", lead: 0 },
          name,
        );
      }

      // The assistant's team: the Assistant leads, everyone else follows.
      assert.deepEqual(byName.get("Assistant"), {
        name: "Assistant",
        team: "assistant",
        is_lead: 1,
        pinned: 1,
      });
      for (const name of ["Planner", "Scout", "Musey"]) {
        assert.deepEqual(
          { team: byName.get(name)?.team, lead: byName.get(name)?.is_lead },
          { team: "assistant", lead: 0 },
          name,
        );
      }

      // Exactly one lead per team, and exactly the two heads are pinned.
      assert.deepEqual(
        rows
          .filter((row) => row.is_lead === 1)
          .map((row) => row.team)
          .toSorted(),
        ["assistant", "dev"],
      );
      assert.deepEqual(
        rows
          .filter((row) => row.pinned === 1)
          .map((row) => row.name.trim())
          .toSorted(),
        ["Assistant", "CTO"],
      );
    }),
  );

  it.effect("defaults a bot created before teams existed to the assistant's team", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* insertBot(sql, "bot-new", "Somebody Else");

      yield* runMigrations({ toMigrationInclusive: 69 });

      const rows = yield* sql<TeamRow>`
        SELECT name, team, is_lead, pinned FROM personal_bots WHERE bot_id = 'bot-new'
      `;
      assert.deepEqual(rows, [{ name: "Somebody Else", team: "assistant", is_lead: 0, pinned: 0 }]);
    }),
  );
});
